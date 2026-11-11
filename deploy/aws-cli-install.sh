#!/bin/bash
# Installs the official AWS CLI v2 to /usr/local/aws-cli (+ /usr/local/bin/aws) if no aws CLI is present. Called from
# server-hook.sh as root. The zip is checked against the AWS CLI Team PGP key (aws-cli-team.asc, fingerprint
# FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C) before anything runs. Idempotent; never prints secrets.
command -v aws >/dev/null && exit 0
FPR=FB5DB77FD5C118B80511ADA8A6310ACC4672475C
D=$(cd "$(dirname "$0")" && pwd)
case "$(uname -m)" in x86_64) A=x86_64 ;; aarch64) A=aarch64 ;; *) echo "aws-cli: unsupported arch"; exit 0 ;; esac
APT="apt-get -y -o DPkg::Lock::Timeout=300 --no-install-recommends"
need=""; command -v unzip >/dev/null || need="$need unzip"; command -v gpg >/dev/null || need="$need gnupg"
[ -n "$need" ] && { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 update -qq && DEBIAN_FRONTEND=noninteractive $APT install $need >/dev/null; } || true
command -v unzip >/dev/null && command -v gpg >/dev/null || { echo "aws-cli: unzip/gpg missing"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export GNUPGHOME="$T/gpg"; mkdir -m 700 "$GNUPGHOME"
U=https://awscli.amazonaws.com/awscli-exe-linux-$A.zip
curl -fsSL --retry 3 -m 300 "$U" -o "$T/a.zip" && curl -fsSL --retry 3 -m 60 "$U.sig" -o "$T/a.sig" || { echo "aws-cli: download failed"; exit 0; }
gpg -q --import "$D/aws-cli-team.asc" 2>/dev/null
gpg --status-fd 1 --verify "$T/a.sig" "$T/a.zip" 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG $FPR " || { echo "aws-cli: SIGNATURE CHECK FAILED, not installing"; exit 0; }
unzip -q "$T/a.zip" -d "$T" && "$T/aws/install" -i /usr/local/aws-cli -b /usr/local/bin >/dev/null && echo "aws-cli: installed $(/usr/local/bin/aws --version 2>&1 | cut -d' ' -f1)" || echo "aws-cli: install failed"
exit 0
