import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
export default defineWorkersConfig({
	test: {
		include: ['test/mailbox-key.spec.js', 'test/account-forward.spec.js'],
		poolOptions: { workers: { miniflare: {
			compatibilityDate: '2025-06-04', compatibilityFlags: ['nodejs_compat'], d1Databases: ['db']
		} } }
	}
});
