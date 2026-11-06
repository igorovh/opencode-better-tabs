# Records docs/demo.gif with made-up data only.
#   bash docs/demo-setup.sh "$TEMP/better-tabs-demo"
#   DEMO_DIR="$TEMP/better-tabs-demo" OPENCODE=<path to the V2 binary> vhs docs/demo.tape
# Written for Windows PowerShell. VHS cannot send alt+digit or alt+up, so their escape sequences are typed instead.

Output docs/demo.gif
Set Shell "powershell"
Set FontSize 18
Set Width 1300
Set Height 620
Set Padding 12
Set Framerate 20
Set TypingSpeed 60ms

Hide
Type `$d=$env:DEMO_DIR; $env:HOME="$d/home"; $env:USERPROFILE="$d/home"; $env:XDG_CONFIG_HOME="$d/xdg/config"; $env:XDG_DATA_HOME="$d/xdg/data"; $env:XDG_STATE_HOME="$d/xdg/state"; $env:XDG_CACHE_HOME="$d/xdg/cache"; cd "$d/home/demo/acme-api"; cls; & $env:OPENCODE --standalone`
Enter
Sleep 12s
Show

# Tabs are grouped by repository, each group with its shortcut.
Sleep 2.5s

# alt+2 selects acme-web and shows its tab keys; alt+2 again opens its second tab.
Type@0ms "2"
Sleep 1.8s
Type@0ms "2"
Sleep 2s

# alt+3 selects acme-mobile; alt+up twice moves the group to the top.
Type@0ms "3"
Sleep 1s
Type@0ms "[1;3A"
Sleep 0.8s
Type@0ms "[1;3A"
Sleep 1.2s
Escape
Sleep 1s

# Search every tab.
Type "/tabs"
Sleep 0.6s
Enter
Sleep 1s
Type "landing"
Sleep 1s
Enter
Sleep 2s

# Compact mode and back.
Type "/tabs-compact"
Sleep 0.6s
Enter
Sleep 2.2s
Type "/tabs-compact"
Sleep 0.6s
Enter
Sleep 2s

Hide
Ctrl+C
Sleep 1s
