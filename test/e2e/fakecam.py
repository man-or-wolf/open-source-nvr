#!/usr/bin/env python3
"""Multi-client fake camera over HTTP mpegts. White box visible 5s..12s of every 20s. usage: fakecam.py port"""
import subprocess, sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('content-type', 'video/mp2t'); self.end_headers()
        p = subprocess.Popen(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i',
            "color=c=black:s=640x480:r=10,drawbox=x=200:y=120:w=160:h=240:c=white:t=fill:enable='gte(mod(t,20),5)*lt(mod(t,20),12)'",
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-pix_fmt', 'yuv420p', '-f', 'mpegts', 'pipe:1'], stdout=subprocess.PIPE)
        try:
            while True:
                d = p.stdout.read(4096)
                if not d: break
                self.wfile.write(d)
        except Exception:
            pass
        finally:
            p.kill()
    def log_message(self, *a): pass
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
