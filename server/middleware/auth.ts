import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getAdminById, AdminPublic } from '../db'

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production'
const JWT_EXPIRES_IN = '7d'

// Extend Express Request to include admin
declare global {
  namespace Express {
    interface Request {
      admin?: AdminPublic
    }
  }
}

export interface JWTPayload {
  adminId: number
  email: string
  shareToken: string
}

// Generate JWT for admin
export function generateToken(admin: AdminPublic): string {
  const payload: JWTPayload = {
    adminId: admin.id,
    email: admin.email,
    shareToken: admin.share_token,
  }

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

// Verify JWT and extract payload
export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload
  } catch {
    return null
  }
}

// Express middleware to require authentication
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.substring(7)
  const payload = verifyToken(token)

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const admin = getAdminById(payload.adminId)
  if (!admin) {
    return res.status(401).json({ error: 'Admin not found' })
  }

  req.admin = admin
  next()
}

// Verify token from Socket.IO handshake
export function verifySocketToken(token: string): AdminPublic | null {
  const payload = verifyToken(token)
  if (!payload) {
    return null
  }

  return getAdminById(payload.adminId)
}
