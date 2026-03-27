# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DeskShare - A simple internal web app for one-way screen sharing. Workers open a URL, click one button to share their screen, and the shared screen appears live on a dashboard in a mosaic/grid layout.

## Tech Stack

- **Frontend**: Vue 3 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Realtime signaling**: Socket.IO
- **Media transport**: WebRTC (direct peer-to-peer)
- **Backend**: Express + Socket.IO signaling server

## Development Commands

```bash
# Install dependencies
npm install

# Run both client and server in development
npm run dev

# Run only the Vite dev server (port 3000)
npm run dev:client

# Run only the signaling server (port 3001)
npm run dev:server

# Build for production
npm run build
```

## Architecture

### Roles
1. **Worker/Sharer** (`/share/[token]`) - Opens URL, clicks button to share screen via WebRTC
2. **Dashboard/Viewer** (`/dashboard`) - Views all active screen shares in a grid, password-protected

### WebRTC Flow
- Worker captures screen with `getDisplayMedia({ video: true, audio: false })`
- Worker sends WebRTC offer through Socket.IO signaling
- Dashboard receives offer, sends answer
- ICE candidates exchanged via signaling
- Stream flows directly peer-to-peer

### Signaling Events
- `join-share` / `share-ready` - Worker joins
- `join-dashboard` / `active-sessions` - Dashboard joins
- `request-offer` / `viewer-joined` - Dashboard requests stream
- `offer` / `answer` / `ice-candidate` - WebRTC negotiation
- `share-stopped` / `session-left` - Cleanup

### Key Files
- `server/index.ts` - Socket.IO signaling server
- `src/lib/webrtc.ts` - WebRTC peer connection utilities
- `src/lib/socket.ts` - Socket.IO client singleton
- `src/views/SharePage.vue` - Worker screen sharing page
- `src/views/DashboardPage.vue` - Admin dashboard with grid

## Important Constraints

- **No audio** - `getDisplayMedia` always called with `audio: false`
- **No recording/storage** - Live transport only, no persistence
- **Browser limitation** - Screen sharing requires user click + native picker dialog (cannot auto-start)
- **MVP auth** - Dashboard uses simple password ("admin" by default)

## Environment Variables

Copy `.env.example` to `.env`:
- `VITE_STUN_URL` - STUN server (defaults to Google's public STUN)
- `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD` - Optional TURN for NAT traversal
- `DASHBOARD_PASSWORD` - Dashboard access password
- `PORT` - Signaling server port (default 3001)
