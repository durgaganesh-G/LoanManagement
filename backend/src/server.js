import "dotenv/config";
import app from "./app.js";
import { prisma } from "./data-access/prisma.js";

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => console.log(`Loan Origination & Eligibility Assistant API listening on ${port}`));

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
