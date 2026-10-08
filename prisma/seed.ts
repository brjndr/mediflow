import { PrismaClient } from '../src/generated/prisma/client.js'

import { getDatabaseUrl } from '../src/database-url.js'

import { PrismaPg } from '@prisma/adapter-pg'

import { buildSeed } from '../src/lib/hospital/seed-data'

const adapter = new PrismaPg({
  connectionString: getDatabaseUrl(),
})

const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('🌱 Seeding database...')

  // Clear existing todos
  await prisma.todo.deleteMany()

  // Create example todos
  const todos = await prisma.todo.createMany({
    data: [
      { title: 'Buy groceries' },
      { title: 'Read a book' },
      { title: 'Workout' },
    ],
  })

  console.log(`✅ Created ${todos.count} todos`)

  // Hospital demo data (same deterministic dataset as the in-memory repo)
  const { doctors, patients, appointments } = buildSeed()
  await prisma.appointment.deleteMany()
  await prisma.patient.deleteMany()
  await prisma.doctor.deleteMany()
  await prisma.doctor.createMany({ data: doctors })
  await prisma.patient.createMany({
    data: patients.map((p) => ({
      ...p,
      dateOfBirth: new Date(p.dateOfBirth),
      admittedAt: new Date(p.admittedAt),
    })),
  })
  await prisma.appointment.createMany({
    data: appointments.map((a) => ({
      ...a,
      scheduledAt: new Date(a.scheduledAt),
    })),
  })
  console.log(
    `✅ Seeded ${doctors.length} doctors, ${patients.length} patients, ${appointments.length} appointments`,
  )
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
