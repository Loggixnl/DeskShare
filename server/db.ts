import { createClient } from '@libsql/client'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'

// Turso database configuration
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:./data/local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

// Initialize database tables
async function initializeDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      share_token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)
  console.log('[DB] Database initialized')
}

// Initialize on module load
initializeDatabase().catch(console.error)

export interface Admin {
  id: number
  email: string
  password_hash: string
  share_token: string
  created_at: string
}

export interface AdminPublic {
  id: number
  email: string
  share_token: string
  created_at: string
}

// Create a new admin account
export async function createAdmin(
  email: string,
  password: string
): Promise<AdminPublic> {
  console.log('[DB] createAdmin called for:', email)

  // Check if email already exists
  console.log('[DB] Checking if email exists...')
  const existing = await db.execute({
    sql: 'SELECT * FROM admins WHERE email = ?',
    args: [email],
  })

  if (existing.rows.length > 0) {
    console.log('[DB] Email already exists')
    throw new Error('Email already registered')
  }
  console.log('[DB] Email is available')

  // Hash password
  console.log('[DB] Hashing password...')
  const passwordHash = await bcrypt.hash(password, 10)
  console.log('[DB] Password hashed')

  // Generate unique share token
  console.log('[DB] Generating share token...')
  const shareToken = uuidv4()
  console.log('[DB] Share token generated:', shareToken)

  // Insert admin
  console.log('[DB] Inserting admin...')
  const result = await db.execute({
    sql: 'INSERT INTO admins (email, password_hash, share_token) VALUES (?, ?, ?)',
    args: [email, passwordHash, shareToken],
  })
  console.log('[DB] Admin inserted with id:', result.lastInsertRowid)

  return {
    id: Number(result.lastInsertRowid),
    email,
    share_token: shareToken,
    created_at: new Date().toISOString(),
  }
}

// Verify admin credentials and return admin data
export async function verifyAdmin(
  email: string,
  password: string
): Promise<AdminPublic | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM admins WHERE email = ?',
    args: [email],
  })

  if (result.rows.length === 0) {
    return null
  }

  const admin = result.rows[0] as unknown as Admin
  const valid = await bcrypt.compare(password, admin.password_hash)
  if (!valid) {
    return null
  }

  return {
    id: admin.id,
    email: admin.email,
    share_token: admin.share_token,
    created_at: admin.created_at,
  }
}

// Get admin by ID (for JWT verification)
export async function getAdminById(id: number): Promise<AdminPublic | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM admins WHERE id = ?',
    args: [id],
  })

  if (result.rows.length === 0) {
    return null
  }

  const admin = result.rows[0] as unknown as Admin
  return {
    id: admin.id,
    email: admin.email,
    share_token: admin.share_token,
    created_at: admin.created_at,
  }
}

// Check if a share token is valid (exists in database)
export async function isValidShareToken(token: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT id FROM admins WHERE share_token = ?',
    args: [token],
  })
  return result.rows.length > 0
}

// Get admin by share token
export async function getAdminByShareToken(token: string): Promise<AdminPublic | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM admins WHERE share_token = ?',
    args: [token],
  })

  if (result.rows.length === 0) {
    return null
  }

  const admin = result.rows[0] as unknown as Admin
  return {
    id: admin.id,
    email: admin.email,
    share_token: admin.share_token,
    created_at: admin.created_at,
  }
}

export default db
