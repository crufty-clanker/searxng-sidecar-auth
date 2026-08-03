import { app } from './app.js';

const PORT = parseInt(process.env.LISTEN_ADDR?.split(':')[1] || '8080', 10);

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`Sidecar listening on port ${PORT}`);
}).catch((err) => {
  console.error('Failed to start sidecar:', err);
  process.exit(1);
});

export { app };
