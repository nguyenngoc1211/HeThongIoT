#!/usr/bin/env python3
"""Serve FireRoute and stream ESP32 DHT11 readings to the browser."""

from __future__ import annotations

import argparse
import json
import queue
import re
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import serial


READING_RE = re.compile(
    r"Zone\s+([A-F])\s*\|\s*GPIO\s+(\d+)\s*\|.*?Nhiet do:\s*(-?\d+(?:\.\d+)?)\s*C"
    r"\s*\|\s*Do am:\s*(-?\d+(?:\.\d+)?)\s*%",
    re.IGNORECASE,
)
TIMEOUT_RE = re.compile(r"Zone\s+([A-F]).*(?:TIMEOUT|khong doc|loi)", re.IGNORECASE)


class SerialHub:
    def __init__(self, port: str, baud: int) -> None:
        self.port = port
        self.baud = baud
        self.clients: set[queue.Queue] = set()
        self.lock = threading.Lock()
        self.status = {"connected": False, "message": f"Đang chờ {port}"}

    def subscribe(self) -> queue.Queue:
        client: queue.Queue = queue.Queue(maxsize=100)
        with self.lock:
            self.clients.add(client)
        client.put(("status", self.status.copy()))
        return client

    def unsubscribe(self, client: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(client)

    def publish(self, event: str, payload: dict) -> None:
        with self.lock:
            clients = list(self.clients)
        for client in clients:
            try:
                client.put_nowait((event, payload))
            except queue.Full:
                try:
                    client.get_nowait()
                    client.put_nowait((event, payload))
                except queue.Empty:
                    pass

    def set_status(self, connected: bool, message: str) -> None:
        new_status = {"connected": connected, "message": message, "port": self.port}
        if new_status != self.status:
            self.status = new_status
            self.publish("status", new_status)

    def run(self) -> None:
        while True:
            try:
                with serial.Serial(self.port, self.baud, timeout=1) as device:
                    self.set_status(True, f"Đã kết nối {self.port}")
                    while True:
                        raw = device.readline()
                        if not raw:
                            continue
                        line = raw.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        reading = READING_RE.search(line)
                        if reading:
                            zone, gpio, temperature, humidity = reading.groups()
                            self.publish("reading", {
                                "zone": zone.upper(),
                                "gpio": int(gpio),
                                "temperature": float(temperature),
                                "humidity": float(humidity),
                                "timestamp": int(time.time() * 1000),
                            })
                            continue
                        timeout = TIMEOUT_RE.search(line)
                        if timeout:
                            self.publish("timeout", {
                                "zone": timeout.group(1).upper(),
                                "timestamp": int(time.time() * 1000),
                            })
            except (serial.SerialException, OSError) as exc:
                self.set_status(False, f"Chưa mở được {self.port}: {exc}")
                time.sleep(2)


class DashboardHandler(SimpleHTTPRequestHandler):
    hub: SerialHub

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/serial/events":
            self.serve_events()
            return
        if path == "/api/status":
            body = json.dumps(self.hub.status, ensure_ascii=False).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def serve_events(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        client = self.hub.subscribe()
        try:
            while True:
                try:
                    event, payload = client.get(timeout=15)
                    message = f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    message = ": keep-alive\n\n"
                self.wfile.write(message.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.hub.unsubscribe(client)

    def log_message(self, fmt: str, *args: object) -> None:
        if not self.path.startswith("/api/serial/events"):
            super().log_message(fmt, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description="FireRoute serial dashboard server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8686)
    parser.add_argument("--serial", dest="serial_port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=115200)
    args = parser.parse_args()

    hub = SerialHub(args.serial_port, args.baud)
    DashboardHandler.hub = hub
    threading.Thread(target=hub.run, name="esp32-serial", daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)
    print(f"FireRoute: http://localhost:{args.port}")
    print(f"ESP32: {args.serial_port} @ {args.baud} baud")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nĐã dừng server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
