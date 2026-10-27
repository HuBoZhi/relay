import { startControlRoom, type ControlRoomServerOptions } from '../server.js';

/** Some Windows hosts allocate ephemeral ports from 1024 upward, including
 * ports (such as 6667) that fetch rejects before sending an HTTP request. */
export async function startHttpTestServer(options: ControlRoomServerOptions) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await startControlRoom({ ...options, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/health`);
      await response.arrayBuffer();
      return server;
    } catch (error) {
      await server.close();
      const cause = error instanceof Error ? error.cause : null;
      if (!(cause instanceof Error) || cause.message !== 'bad port') throw error;
    }
  }
  throw new Error('Could not allocate a fetch-compatible control room test port');
}
