# CrystalFront RTS

A multiplayer browser RTS prototype. 1v1 real-time strategy with lobby system, host/join flow, and rematch sessions.

## Project Structure

```
CrystalFront-RTS/
├── client/          # React + Vite frontend
├── server/          # Node.js + Express + ws backend
├── shared/          # Shared TypeScript types and constants
├── tests/           # Automated tests
├── package.json     # Root workspace config
└── tsconfig.json    # Root TypeScript config
```

## Development

### Prerequisites

- Node.js 20+
- npm

### Install Dependencies

```bash
npm install
```

### Run Development Servers

```bash
npm run dev
```

This starts both the client (Vite dev server on port 5173) and server (on port 3777) concurrently. The client proxies API requests to the server.

### Run Tests

```bash
npm run test
```

### Build for Production

```bash
npm run build
```

This builds the client and server. The server output goes to `server/dist/`.

### Start Production Server

```bash
npm start
```

The server serves the built frontend and WebSocket API on port 3777.

## Configuration

### Port

The server port is configurable via the `PORT` environment variable:

```bash
PORT=8080 npm start
```

Defaults to `3777` if not set.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3777` |

## Deployment

### Systemd Service (Debian)

The production server is designed to run under a systemd service on a Debian container (e.g., Proxmox LXC).

1. Build the project: `npm run build`
2. Copy the project to the server (e.g., `/opt/crystalfront-rts`)
3. Create a systemd service file at `/etc/systemd/system/crystalfront-rts.service`:

```ini
[Unit]
Description=CrystalFront RTS Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/crystalfront-rts
Environment=PORT=3777
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

4. Enable and start:

```bash
sudo systemctl enable crystalfront-rts
sudo systemctl start crystalfront-rts
```

5. Check status:

```bash
sudo systemctl status crystalfront-rts
```

### Firewall

Open port 3777 (or your configured port):

```bash
sudo ufw allow 3777/tcp
```

## Stage 1 Features

- **Main Menu**: Username input, host game, join by lobby code, settings placeholder
- **Lobby System**: Create/join lobbies with 6-character codes, ready-up flow
- **Match Flow**: Both players ready → game shell → debug win → match end screen
- **Rematch**: Same lobby persists, score tracks across rematches, ready states reset
- **WebSocket Sync**: Real-time state synchronization between clients and server
- **Server-Authoritative**: Server is source of truth for lobby membership, ready state, and scores

## Manual Verification Steps

### Two-Browser Host/Join Flow

1. Open browser tab 1 → enter username → click "Host Game"
2. Note the 6-character lobby code
3. Open browser tab 2 → enter username → enter lobby code → click "Join"
4. Both tabs should show the lobby with both usernames visible

### Ready-Up Flow

1. Both players click "Ready Up"
2. Both ready badges turn green
3. Both clients transition to the game shell

### Debug Win and Rematch Flow

1. In the game shell, click "Simulate My Win"
2. Match end screen appears with winner display
3. Click "Rematch"
4. Both players return to lobby with ready states reset and score preserved

### Exit Flow

1. Click "Leave Lobby" from the lobby screen
2. Player returns to main menu
3. If both leave, lobby is deleted

### Production Build

1. Run `npm run build`
2. Run `npm start`
3. Open browser to `http://localhost:3777`
4. Verify main menu loads from the Node server

## Known Limitations (Stage 1)

- No actual RTS gameplay (map, units, combat)
- No fog of war (implemented in later stages)
- No reconnect on refresh
- No chat or voice
- Debug controls required to simulate match results
- No replay system
- No external matchmaking (lobby codes only)
