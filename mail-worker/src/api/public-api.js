import app from '../hono/hono';
import result from '../model/result';
import publicService from '../service/public-service';
import mailboxKeyService from '../service/mailbox-key-service';
import BizError from '../error/biz-error';

// These routes own their authentication and HTTP status codes; legacy public APIs stay unchanged.
for (const [method, path, action] of [
	['get', '/public/latest', c => mailboxKeyService.latest(c, c.req.query())],
	['post', '/public/mailboxKeys', async c => {
		let params;
		try { params = await c.req.json(); } catch { throw new BizError('Invalid JSON body', 400); }
		return mailboxKeyService.issue(c, params);
	}]
]) {
	app[method](path, async c => {
		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		try {
			return c.json(result.ok(await action(c)));
		} catch (error) {
			if (error.name === 'BizError') return c.json(result.fail(error.message, error.code), error.code);
			throw error;
		}
	});
}

app.post('/public/genToken', async (c) => {
	const data = await publicService.genToken(c, await c.req.json());
	return c.json(result.ok(data));
});

app.post('/public/emailList', async (c) => {
	const list = await publicService.emailList(c, await c.req.json());
	return c.json(result.ok(list));
});

app.post('/public/addUser', async (c) => {
	await publicService.addUser(c, await c.req.json());
	return c.json(result.ok());
});
