import tls from 'node:tls';
import type { TlsInfo } from './types';

/** Reads the leaf certificate of `host:port` and reports its expiry. Never throws. */
export function checkCertificate(host: string, port = 443, timeoutMs = 10000, now = new Date()): Promise<TlsInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (info: TlsInfo) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(info);
    };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ host, error: 'no peer certificate presented' });
      const validTo = new Date(cert.valid_to);
      finish({
        host,
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - now.getTime()) / 86400000),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : undefined,
      });
    });
    socket.on('timeout', () => finish({ host, error: `TLS handshake timeout after ${timeoutMs}ms` }));
    socket.on('error', (e) => finish({ host, error: e.message }));
  });
}
