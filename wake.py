#!/usr/bin/env python3
"""Wake a RigWatch machine with a Wake-on-LAN magic packet.

Run this on another computer in the same network:

    python3 wake.py 00:11:22:33:44:55
    python3 wake.py 00:11:22:33:44:55 --broadcast 192.168.1.255

The target needs Wake-on-LAN enabled in the BIOS/UEFI and on its network card
(install.sh --wol <interface> keeps the latter switched on).
"""
import argparse
import re
import socket


def magic_packet(mac):
    digits = re.sub(r"[^0-9a-fA-F]", "", mac)
    if len(digits) != 12:
        raise SystemExit(f"Not a MAC address: {mac}")
    return bytes.fromhex("ff" * 6 + digits * 16)


def main():
    parser = argparse.ArgumentParser(description="Send a Wake-on-LAN magic packet")
    parser.add_argument("mac", help="MAC address of the machine to wake")
    parser.add_argument("--broadcast", default="255.255.255.255", help="broadcast address of your network")
    args = parser.parse_args()
    packet = magic_packet(args.mac)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            sock.sendto(packet, (args.broadcast, port))
    print(f"Magic packet sent to {args.mac} via {args.broadcast}")


if __name__ == "__main__":
    main()
