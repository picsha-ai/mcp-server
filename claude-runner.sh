#!/bin/bash
# Wrapper to ensure stdio streams don't hang when launched by Claude Desktop macOS app
# The app's native pipes can sometimes cause Node.js to drop stdio events. 
# Piping through cat normalizes the streams.
cat - | /opt/homebrew/bin/node "$(dirname "$0")/dist/index.js" "$@"
