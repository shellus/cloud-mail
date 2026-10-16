import verifyUtils from './verify-utils.js';
import emailUtils from './email-utils.js';

const encoder = new TextEncoder();
const context = 'cloud-mail:mailbox-latest:v1:';

export function normalizeMailboxAddress(value) {
	const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
	const name = emailUtils.getName(address);
	const domain = emailUtils.getDomain(address);
	if (address.length > 254 || !verifyUtils.isEmail(address) || name.length > 64 ||
		name.startsWith('.') || name.endsWith('.') || name.includes('..') ||
		domain.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
		throw new Error('Invalid email address');
	}
	return address;
}

export async function importMailboxSigningKey(secret) {
	if (typeof secret !== 'string' || secret.length < 32) throw new Error('Mailbox key service is not configured');
	return crypto.subtle.importKey('raw', encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function deriveMailboxKey(key, address) {
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(context + address));
	return btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifyMailboxKey(key, address, value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
	const signature = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), char => char.charCodeAt(0));
	const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(context + address));
	// Reject noncanonical base64url encodings as well as signatures for other mailboxes.
	return valid && value === await deriveMailboxKey(key, address);
}
