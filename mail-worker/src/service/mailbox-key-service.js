import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import orm from '../entity/orm';
import email from '../entity/email';
import { emailConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import publicService from './public-service';
import { normalizeMailboxAddress, importMailboxSigningKey, deriveMailboxKey, verifyMailboxKey } from '../utils/mailbox-key-utils.mjs';

const mailboxKeyService = {

	normalize(c, value) {
		let address;
		try { address = normalizeMailboxAddress(value); } catch { throw new BizError('Invalid email address', 400); }
		const domain = emailUtils.getDomain(address);
		const domains = typeof c.env.domain === 'string' ? JSON.parse(c.env.domain) : c.env.domain;
		if (!Array.isArray(domains) || !domains.some(item => item.trim().replace(/^@/, '').toLowerCase() === domain)) {
			throw new BizError('Unsupported email domain', 400);
		}
		return address;
	},

	async signingKey(c) {
		if (typeof c.env.mailbox_key_secret !== 'string' || c.env.mailbox_key_secret.length < 32) {
			throw new BizError('Mailbox key service is not configured', 503);
		}
		return importMailboxSigningKey(c.env.mailbox_key_secret);
	},

	async issue(c, params) {
		if (!params || typeof params.email !== 'string' || typeof params.password !== 'string') {
			throw new BizError('Invalid administrator credentials', 401);
		}
		try {
			await publicService.verifyUser(c, params);
		} catch (error) {
			if (error.name === 'BizError') throw new BizError('Invalid administrator credentials', 401);
			throw error;
		}
		if (!Array.isArray(params.emails) || params.emails.length < 1 || params.emails.length > 100) {
			throw new BizError('emails must contain 1 to 100 addresses', 400);
		}
		const addresses = [...new Set(params.emails.map(value => this.normalize(c, value)))];
		const key = await this.signingKey(c);
		return Promise.all(addresses.map(async address => ({ email: address, key: await deriveMailboxKey(key, address) })));
	},

	async latest(c, params) {
		const address = this.normalize(c, params.email);
		const key = await this.signingKey(c);
		if (!await verifyMailboxKey(key, address, params.key)) {
			throw new BizError('Invalid mailbox key', 401);
		}
		const [row] = await orm(c).select({
			emailId: email.emailId,
			toEmail: email.toEmail,
			sendEmail: email.sendEmail,
			sendName: email.name,
			subject: email.subject,
			text: email.text,
			html: email.content,
			createTime: email.createTime,
			code: email.code,
		}).from(email).where(and(
			sql`${email.toEmail} = ${address} COLLATE NOCASE`,
			eq(email.type, emailConst.type.RECEIVE),
			eq(email.isDel, isDel.NORMAL),
			inArray(email.status, [emailConst.status.RECEIVE, emailConst.status.NOONE])
		)).orderBy(desc(email.emailId)).limit(1);
		return row ? { ...row, text: row.text ?? '', html: row.html ?? '', code: row.code ?? '' } : null;
	}
};

export default mailboxKeyService;
