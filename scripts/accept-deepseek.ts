import { acceptDevice } from './accept-device.ts';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--default-home'))
  throw new Error('usage: accept-deepseek.ts [--default-home]');
await acceptDevice('deepseek-harness', undefined, { deepseekEnvironment: args[0] === '--default-home' ? 'default' : 'isolated' });
