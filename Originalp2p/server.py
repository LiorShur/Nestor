#!/usr/bin/env python3
"""
CareCall Server
───────────────
Runs a WebSocket relay (port 8765) and HTTP file server (port 8080)
in one command. Both phones connect to this machine over local WiFi.

Usage:
    pip install websockets
    python3 server.py

Then on each phone open:
    http://YOUR-COMPUTER-IP:8080/patient.html
    http://YOUR-COMPUTER-IP:8080/carer.html

Your computer's local IP is printed when the server starts.
"""

import asyncio
import websockets
import json
import http.server
import threading
import socket
import os
import sys

# ── Find local IP ──────────────────────────────────────
def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

# ── WebSocket relay ────────────────────────────────────
clients = {}   # role -> websocket

async def handler(websocket):
    role = None
    try:
        # First message must register the role
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        data = json.loads(raw)
        role = data.get("role")

        if role not in ("patient", "carer"):
            print(f"[!!] Unknown role '{role}' — closing")
            await websocket.close()
            return

        # If same role reconnects, close old connection cleanly
        if role in clients:
            try:
                await clients[role].close()
            except:
                pass

        clients[role] = websocket
        other = "carer" if role == "patient" else "patient"
        print(f"[+] {role} connected  (clients: {list(clients.keys())})")

        # Tell the other side this role just came online
        if other in clients:
            try:
                await clients[other].send(json.dumps({"type": "peer-online", "role": role}))
            except:
                pass

        # Relay loop
        async for message in websocket:
            if other in clients:
                try:
                    await clients[other].send(message)
                except:
                    pass   # other side gone — they'll reconnect

    except asyncio.TimeoutError:
        print("[!] Client connected but never registered")
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[!] Error: {e}")
    finally:
        if role and clients.get(role) is websocket:
            del clients[role]
            print(f"[-] {role} disconnected  (clients: {list(clients.keys())})")
            other = "carer" if role == "patient" else "patient"
            if other in clients:
                try:
                    await clients[other].send(json.dumps({"type": "peer-offline", "role": role}))
                except:
                    pass

async def ws_server():
    async with websockets.serve(handler, "0.0.0.0", 8765, ping_interval=20, ping_timeout=20):
        print(f"[WS]   ws://{local_ip()}:8765  (WebSocket relay)")
        await asyncio.Future()

# ── HTTP file server ───────────────────────────────────
class SilentHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass   # suppress per-request logs

def http_server():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = http.server.HTTPServer(("0.0.0.0", 8080), SilentHandler)
    httpd.serve_forever()

# ── Main ───────────────────────────────────────────────
if __name__ == "__main__":
    ip = local_ip()
    print()
    print("╔══════════════════════════════════════════════╗")
    print("║           CareCall Server                    ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║  Patient : http://{ip}:8080/patient.html  ")
    print(f"║  Carer   : http://{ip}:8080/carer.html    ")
    print("║                                              ║")
    print("║  Press Ctrl+C to stop                        ║")
    print("╚══════════════════════════════════════════════╝")
    print()

    # HTTP in background thread
    t = threading.Thread(target=http_server, daemon=True)
    t.start()
    print(f"[HTTP] http://{ip}:8080  (file server)")

    # WebSocket in main async loop
    try:
        asyncio.run(ws_server())
    except KeyboardInterrupt:
        print("\n[CareCall] Stopped.")
