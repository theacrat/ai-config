import { createService } from "../src/service";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
const server = createService(token);
server.on("error", () => process.exit(1));
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
});
process.on("SIGINT", () => {
  server.close();
  server.closeAllConnections();
});
