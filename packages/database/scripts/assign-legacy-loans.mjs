import dotenv from 'dotenv';
import { resolve } from 'node:path';
import prismaPackage from '@prisma/client';

const { PrismaClient } = prismaPackage;

dotenv.config({ path: resolve(process.cwd(), '../../.env') });

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run db:assign-legacy-loans -- owner@example.com');
  process.exit(1);
}

const db = new PrismaClient();
try {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user was found for ${email}. Sign in once before assigning legacy loans.`);
  const result = await db.loan.updateMany({ where: { userId: null }, data: { userId: user.id } });
  console.log(`Assigned ${result.count} legacy loan(s) to ${user.email}.`);
} finally {
  await db.$disconnect();
}
