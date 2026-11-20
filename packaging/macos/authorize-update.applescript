on run argv
    set cmd to "/bin/bash -p -c " & quoted form of (item 1 of argv) & " install-update"
    repeat with arg in rest of argv
        set cmd to cmd & " " & quoted form of (contents of arg)
    end repeat
    do shell script cmd with administrator privileges
end run
