"""Builds the family-tablet website (index.html) from the tested app page (app.html)."""
import pathlib
here=pathlib.Path(__file__).parent
app=(here/"app.html").read_text()
for a,b in [('<span><b>Test mode</b> · no passwords</span>','<span><b>Espinal Family</b></span>'),
            ("I'm not allowed to think right now. Allow this app to use Claude to talk with me.","I need my brain connected first. Ask Dad or Mom to add the brain key in Family → Coco's brain."),
            ('Reset all test data','Reset all data'),('Clears everyone, every message, task and check-in so you can test setup from the start.','Erases everyone, every message, task and check-in on this tablet. This can\'t be undone.'),
            ('Test data</div>','Danger zone</div>')]:
    assert a in app,a; app=app.replace(a,b)
i=app.index('<script src="https://cdn.jsdelivr.net/npm/sam-js')
app=app[:i]+'<script src="local-shim.js"></script>\n'+app[i:]
head='''<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#04050d"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="Espinal">
<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icons/icon-192.png"><link rel="apple-touch-icon" href="icons/icon-192.png">
<style>html,body{margin:0;height:100%}:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}body{background:#04050d}</style>
</head><body>
'''
(here/"index.html").write_text(head+app+"\n</body></html>\n")
print("index.html built")
