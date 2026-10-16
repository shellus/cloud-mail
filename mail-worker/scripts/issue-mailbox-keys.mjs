import { normalizeMailboxAddress, importMailboxSigningKey, deriveMailboxKey } from '../src/utils/mailbox-key-utils.mjs';

// Local administrator entry point: possession of the signing secret authorizes issuance.
try {
	const values = process.argv.slice(2);
	if (!values.length) throw new Error('Usage: MAILBOX_KEY_SECRET=<secret> node scripts/issue-mailbox-keys.mjs <email> [email ...]');
	const addresses = [...new Set(values.map(normalizeMailboxAddress))];
	const key = await importMailboxSigningKey(process.env.MAILBOX_KEY_SECRET);
	const list = await Promise.all(addresses.map(async email => ({ email, key: await deriveMailboxKey(key, email) })));
	process.stdout.write(JSON.stringify(list, null, 2) + '\n');
} catch (error) {
	process.stderr.write(error.message + '\n');
	process.exitCode = 1;
}
