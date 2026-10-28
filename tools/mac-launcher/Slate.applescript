-- Opens Slate in Opera. Starts Slate's server (and the copilot's) first if
-- they are not running. Built from tools/mac-launcher/build.sh.
--
-- WHICH OPERA: the copilot's window (profile ~/.browser-copilot-opera), the
-- same one the Launch Opera button opens. That is the window the copilot can
-- see, and it is the only Opera that behaves when asked to open a link from
-- outside: handing a URL to Opera with `open -a` while the copilot instance
-- is running produced a black page (Sep 10). So the launcher asks the
-- copilot's own launch route for the tab, then brings it to the front.
-- If the copilot cannot be started, it falls back to `open -a`.
set home to POSIX path of (path to home folder)
set slateDir to home & "Desktop/School Tracker"
set copilotDir to slateDir & "/browser-copilot"
set opera to home & "Applications/Opera.app"
set slateUrl to "http://localhost:4173"
set copilotUrl to "http://localhost:4321"
set logFile to home & "Library/Logs/slate-launcher.log"

-- node is not on Finder's PATH; use the copy Will installed under ~/.local.
set nodePick to "NODE=\"$HOME/.local/lib/nodejs/current/bin/node\"; [ -x \"$NODE\" ] || NODE=$(ls -d \"$HOME\"/.local/lib/nodejs/node-v*/bin/node 2>/dev/null | tail -1); "

on probe(u)
	return do shell script "curl -s -m 2 -o /dev/null -w '%{http_code}' " & u & "/api/status || true"
end probe

on waitFor(u)
	repeat 40 times
		delay 0.5
		if my probe(u) is "200" then return true
	end repeat
	return false
end waitFor

-- 1. Slate itself. SLATE_OPEN=0 stops the server opening the default
-- browser on its own; this launcher opens Opera. The WHOLE subshell is
-- redirected and backgrounded: with only the node command redirected, the
-- subshell running the cd && list keeps this script's output pipe open until
-- Slate exits, and the launcher hangs instead of opening Opera (measured).
if probe(slateUrl) is not "200" then
	do shell script nodePick & "(cd " & quoted form of slateDir & " && SLATE_OPEN=0 nohup \"$NODE\" server.js) > " & quoted form of logFile & " 2>&1 < /dev/null &"
	if not waitFor(slateUrl) then
		display dialog "Slate did not start. The log is in Library/Logs/slate-launcher.log in your home folder." buttons {"OK"} default button 1 with icon stop with title "Slate"
		return
	end if
end if

-- 2. The copilot server, whose launch route owns the Opera window.
set copilotUp to (probe(copilotUrl) is "200")
if not copilotUp then
	try
		do shell script nodePick & "(cd " & quoted form of copilotDir & " && nohup \"$NODE\" server.js) > " & quoted form of (home & "Library/Logs/slate-copilot-launcher.log") & " 2>&1 < /dev/null &"
		set copilotUp to waitFor(copilotUrl)
	end try
end if

-- 3. Ask it for a Slate tab (it starts Opera if needed: ~30s cold), then
-- front that tab and the Opera window.
set opened to false
if copilotUp then
	try
		set reply to do shell script "curl -s -m 70 -X POST -H 'content-type: application/json' -d '{\"startUrl\":\"" & slateUrl & "\"}' " & copilotUrl & "/api/launch-chrome"
		if reply contains "\"ok\":true" then
			do shell script "sleep 1; id=$(curl -s -m 3 http://127.0.0.1:9222/json/list | python3 -c 'import json,sys; ts=[t for t in json.load(sys.stdin) if t.get(\"type\")==\"page\" and t.get(\"url\",\"\").rstrip(\"/\")==\"" & slateUrl & "\"]; print(ts[0][\"id\"] if ts else \"\")'); [ -n \"$id\" ] && curl -s -m 3 -X PUT \"http://127.0.0.1:9222/json/activate/$id\" > /dev/null; true"
			do shell script "open -a " & quoted form of opera
			set opened to true
		end if
	end try
end if

if not opened then
	do shell script "open -a " & quoted form of opera & " " & slateUrl
end if
