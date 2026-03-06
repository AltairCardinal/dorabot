import { homedir } from 'os';
import { join } from 'path';

export const DORABOT_DIR = join(homedir(), '.dorabot');
export const DORABOT_LOGS_DIR = join(DORABOT_DIR, 'logs');
export const GATEWAY_TOKEN_PATH = join(DORABOT_DIR, 'gateway-token');
export function getGatewayIpcPath(baseDir = DORABOT_DIR): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\dorabot-gateway';
  }
  return join(baseDir, 'gateway.sock');
}
export const GATEWAY_IPC_PATH = getGatewayIpcPath();
// Backward-compatible alias for older imports.
export const GATEWAY_SOCKET_PATH = GATEWAY_IPC_PATH;
export const GATEWAY_LOG_PATH = join(DORABOT_LOGS_DIR, 'gateway.log');
