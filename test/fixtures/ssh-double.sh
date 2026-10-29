#!/bin/sh
# Test double for the real ssh client.
#
# Drops "-o key value" pairs and the host argument, then runs the command locally so the
# extension's remote code paths are exercised without a real server. Records the host it
# was asked for in last-host.txt so tests can assert the routing.
args=""
host=""
command=""
while [ $# -gt 0 ]; do
	case "$1" in
		-o)
			shift 2
			;;
		*)
			if [ -z "$host" ]; then
				host="$1"
			else
				command="$1"
			fi
			shift
			;;
	esac
done

: "${SSH_DOUBLE_LOG:=$(dirname "$0")/last-host.txt}"
printf '%s' "$host" > "$SSH_DOUBLE_LOG"
exec /bin/sh -c "$command"
