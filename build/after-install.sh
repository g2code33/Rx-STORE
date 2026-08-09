#!/bin/sh
# Link the RX Store binary onto PATH after .deb install
set -e
ln -sf '/opt/RX Store/rx-store' '/usr/bin/rx-store'
