export { ReMarkableSSHClient } from './ssh-client';
export type { CommandResult, SSHExecutor } from './ssh-client';

export {
  connectAndVerify,
  testConnection,
} from './connection-manager';
export type {
  ProgressCallback,
  ConnectionResult,
} from './connection-manager';
