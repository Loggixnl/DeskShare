import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs'

// Database path from env or default
const DB_PATH = process.env.DATABASE_PATH || './data/deskshare.db'

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH)
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Initialize database connection
const db = new Database(DB_PATH)

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL')

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    share_token TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`)

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

// Prepared statements for performance
const findAdminByEmail = db.prepare<[string], Admin>(
  'SELECT * FROM admins WHERE email = ?'
)

const findAdminByToken = db.prepare<[string], Admin>(
  'SELECT * FROM admins WHERE share_token = ?'
)

const findAdminById = db.prepare<[number], Admin>(
  'SELECT * FROM admins WHERE id = ?'
)

const insertAdmin = db.prepare<[string, string, string]>(
  'INSERT INTO admins (email, password_hash, share_token) VALUES (?, ?, ?)'
)

// Create a new admin account
export async function createAdmin(
  email: string,
  password: string
): Promise<AdminPublic> {
  // Check if email already exists
  const existing = findAdminByEmail.get(email)
  if (existing) {
    throw new Error('Email already registered')
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10)

  // Generate unique share token
  const shareToken = uuidv4()

  // Insert admin
  const result = insertAdmin.run(email, passwordHash, shareToken)

  return {
    id: result.lastInsertRowid as number,
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
  const admin = findAdminByEmail.get(email)
  if (!admin) {
    return null
  }

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
export function getAdminById(id: number): AdminPublic | null {
  const admin = findAdminById.get(id)
  if (!admin) {
    return null
  }

  return {
    id: admin.id,
    email: admin.email,
    share_token: admin.share_token,
    created_at: admin.created_at,
  }
}

// Check if a share token is valid (exists in database)
export function isValidShareToken(token: string): boolean {
  const admin = findAdminByToken.get(token)
  return !!admin
}

// Get admin by share token
export function getAdminByShareToken(token: string): AdminPublic | null {
  const admin = findAdminByToken.get(token)
  if (!admin) {
    return null
  }

  return {
    id: admin.id,
    email: admin.email,
    share_token: admin.share_token,
    created_at: admin.created_at,
  }
}

export default db
