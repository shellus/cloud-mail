import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { dbInit } from '../src/init/init';
import cryptoUtils from '../src/utils/crypto-utils';
import KvConst from '../src/const/kv-const';

let bindings;
const address = 'nobody@local.example';
const password = 'administrator-password';
const request = (path, options) => worker.fetch(new Request('https://mail.example/api' + path, options), bindings, {});
const post = body => request('/public/mailboxKeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const issue = emails => post({ email: bindings.admin, password, emails });
const keyFor = async (email = address) => (await (await issue([email])).json()).data[0].key;
const latest = (email, key, headers) => request('/public/latest?' + new URLSearchParams({ email, ...(key === undefined ? {} : { key }) }), { headers });
const insert = (to = address, overrides = {}) => {
	const row = { to_email: to, account_id: 0, user_id: 0, type: 0, status: 7, is_del: 0,
		send_email: 'sender@example.com', name: 'Sender', subject: 'Verification',
		text: 'Your code is 123456', content: '<p>Your code is 123456</p>', code: '123456', ...overrides };
	return env.db.prepare(`INSERT INTO email (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
};

beforeEach(async () => {
	bindings = { ...env, admin: 'admin@local.example', domain: ['local.example'], mailbox_key_secret: 'test-only-master-secret-with-at-least-32-characters', kv: { get: vi.fn(async () => 'legacy-public-token') } };
	const c = { env: bindings };
	await dbInit.intDB(c);
	await dbInit.v1_1DB(c);
	await env.db.batch([
		env.db.prepare("ALTER TABLE email ADD COLUMN to_email TEXT NOT NULL DEFAULT ''"),
		env.db.prepare("ALTER TABLE email ADD COLUMN to_name TEXT NOT NULL DEFAULT ''"),
		env.db.prepare("ALTER TABLE email ADD COLUMN code TEXT NOT NULL DEFAULT ''"),
		env.db.prepare('ALTER TABLE user ADD COLUMN reg_key_id INTEGER NOT NULL DEFAULT 0')
	]);
	const { salt, hash } = await cryptoUtils.hashPassword(password);
	await env.db.prepare('INSERT INTO user (email, salt, password) VALUES (?, ?, ?)').bind(bindings.admin, salt, hash).run();
});

describe('mailbox key HTTP endpoints with D1', () => {
	it('issues deterministic, distinct 256-bit keys only with administrator credentials', async () => {
		const response = await issue([address, 'other@local.example', ' NOBODY@LOCAL.EXAMPLE ']);
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const { data } = await response.json();
		expect(data).toHaveLength(2);
		expect(data[0].key).toMatch(/^[\w-]{43}$/);
		expect(data[0].key).not.toBe(data[1].key);
		expect(await keyFor()).toBe(data[0].key);
		for (const credentials of [{}, { email: bindings.admin, password: 'wrong' }, { email: address, password }]) {
			expect((await post({ ...credentials, emails: [address] })).status).toBe(401);
		}
		expect(await env.db.prepare('SELECT count(*) AS n FROM user').first('n')).toBe(1);
		expect(await env.db.prepare('SELECT count(*) AS n FROM account').first('n')).toBe(0);
	});

	it('reads the latest complete incoming orphan mail with full bodies and AI code', async () => {
		await insert(address, { subject: 'old' });
		await insert('NOBODY@LOCAL.EXAMPLE', { subject: 'new', create_time: '2026-01-01 12:00:00' });
		for (const overrides of [{ type: 1 }, { is_del: 1 }, { status: 6 }]) await insert(address, overrides);
		await insert('another@local.example');
		const response = await latest(' NOBODY@LOCAL.EXAMPLE ', await keyFor());
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect((await response.json()).data).toMatchObject({ emailId: 2, sendEmail: 'sender@example.com', sendName: 'Sender', subject: 'new',
			text: 'Your code is 123456', html: '<p>Your code is 123456</p>', code: '123456', createTime: '2026-01-01 12:00:00' });
		expect(bindings.kv.get).not.toHaveBeenCalled();
	});

	it('also reads registered mailbox mail and returns explicit null for empty mailboxes', async () => {
		const key = await keyFor();
		expect(await (await latest(address, key)).json()).toEqual({ code: 200, message: 'success', data: null });
		await insert(address, { user_id: 1, account_id: 1, status: 0, content: null, text: null, code: '' });
		expect((await (await latest(address, key)).json()).data).toMatchObject({ text: '', html: '', code: '' });
	});

	it('rejects missing, incorrect, noncanonical and cross-mailbox keys with HTTP 401', async () => {
		await insert();
		const key = await keyFor();
		const other = await keyFor('other@local.example');
		for (const candidate of [undefined, '', 'bad', 'A'.repeat(43), other]) {
			const response = await latest(address, candidate, { Authorization: 'legacy-public-token' });
			expect(response.status).toBe(401);
			expect((await response.json()).data).toBeUndefined();
		}
		// SHA-256 base64url has two unused final bits, which must remain zero.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
		const alias = key.slice(0, -1) + alphabet[alphabet.indexOf(key.at(-1)) + 1];
		expect((await latest(address, alias)).status).toBe(401);
		expect((await latest('other@local.example', key)).status).toBe(401);
	});

	it('uses exact addresses without wildcard, plus-alias or dotted-name expansion', async () => {
		await insert('nobody+tag@local.example');
		await insert('no.body@local.example');
		expect((await (await latest(address, await keyFor())).json()).data).toBeNull();
		await insert('wild_card@local.example');
		await insert('wildXcard@local.example', { subject: 'wrong mailbox' });
		expect((await (await latest('wild_card@local.example', await keyFor('wild_card@local.example'))).json()).data.subject).toBe('Verification');
	});

	it('validates batch bounds, JSON, addresses and configured domains', async () => {
		for (const emails of [[], Array(101).fill(address), ['bad'], ['x@external.example'], ['a..b@local.example'], [null]]) {
			expect((await issue(emails)).status).toBe(400);
		}
		expect((await request('/public/mailboxKeys', { method: 'POST', body: '{' })).status).toBe(400);
		expect((await latest('bad-address', 'bad')).status).toBe(400);
		bindings.domain = '["LOCAL.EXAMPLE"]';
		expect((await issue([address])).status).toBe(200);
	});

	it('fails closed without a master secret and invalidates keys after master replacement', async () => {
		const key = await keyFor();
		delete bindings.mailbox_key_secret;
		expect((await latest(address, key)).status).toBe(503);
		expect((await issue([address])).status).toBe(503);
		bindings.mailbox_key_secret = 'a-different-master-secret-with-at-least-32-characters';
		expect((await latest(address, key)).status).toBe(401);
		expect((await latest(address, await keyFor())).status).toBe(200);
	});

	it('preserves legacy public API token protection and rejects suffix bypasses', async () => {
		await insert();
		const body = { method: 'POST', body: JSON.stringify({ toEmail: address }) };
		const unauthorized = await request('/public/emailList', body);
		expect((await unauthorized.json()).code).toBe(401);
		// Legacy APIs use body codes rather than HTTP error statuses.
		expect(unauthorized.status).toBe(200);
		bindings.kv.get.mockImplementation(async key => key === KvConst.PUBLIC_KEY ? 'legacy-public-token' : null);
		const authorized = await request('/public/emailList', { ...body, headers: { Authorization: 'legacy-public-token' } });
		expect((await authorized.json()).data).toHaveLength(1);
		expect(bindings.kv.get).toHaveBeenCalledWith(KvConst.PUBLIC_KEY);
		bindings.kv.put = vi.fn();
		const token = await request('/public/genToken', { method: 'POST', body: JSON.stringify({ email: bindings.admin, password }) });
		expect((await token.json()).data.token).toMatch(/^[a-f0-9-]{36}$/);
		expect(bindings.kv.put).toHaveBeenCalledWith(KvConst.PUBLIC_KEY, expect.any(String));
		for (const suffix of ['/public/latestExtra', '/public/mailboxKeys/extra']) {
			expect((await (await request(suffix)).json()).code).toBe(401);
		}
	});
});
