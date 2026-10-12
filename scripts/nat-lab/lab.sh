#!/usr/bin/env bash
# NAT lab: two devices on two separate NATed networks, a public server with
# preprati. + STUN (+ an optional TURN relay), all in local Docker networks.
# It runs the real production build in real Chrome, so cross-network behaviour
# can be tested without two physical networks. See docs/CONNECTIVITY.md.
#
#   scripts/nat-lab/lab.sh up                 create networks and containers
#   scripts/nat-lab/lab.sh scenarios [1 2 …]  run scenarios (all by default)
#   scripts/nat-lab/lab.sh down               remove everything the lab created
#
# Requirements: Linux, Docker, Node and Google Chrome installed on the host,
# and `npm run build` done. Every Docker object is named preprati-lab-*.
# The containers mount the host filesystem read-only and chroot into it to run
# the host's own Node and Chrome (as the invoking user) inside the lab's
# network namespaces. Results land in test-results/nat-lab/.
#
#   wan   198.18.0.0/24   server .2 (app + STUN), STUN #2 .3, TURN .4, NAT A .11, NAT B .12
#   lan-a 10.71.1.0/24    device A .2 → NAT A .254 (internal network, no other way out)
#   lan-b 10.71.2.0/24    device B .2 → NAT B .254
set -uo pipefail

PROJECT="$(cd "$(dirname "$0")/../.." && pwd)"
LAB="$PROJECT/scripts/nat-lab"
RESULTS="$PROJECT/test-results/nat-lab" # mounted at /tmp inside the device containers
NODE_BIN="${NODE_BIN:-$(command -v node)}"
CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v google-chrome-stable)}"
P=preprati-lab
APP=http://198.18.0.2:4400
STUN_URLS=stun:198.18.0.2:3478,stun:198.18.0.3:3478
HTTP_SIGNALING=(SIGNALING_TRANSPORT=http KV_DRIVER=memory)

up() {
  [ -f "$PROJECT/dist/server/index.js" ] || { echo "Run npm run build first."; exit 1; }
  mkdir -p "$RESULTS"
  docker network inspect $P-wan >/dev/null 2>&1 ||
    docker network create --subnet 198.18.0.0/24 --gateway 198.18.0.1 $P-wan >/dev/null
  for side in a b; do
    local n; n=$(net $side)
    docker network inspect $P-lan-$side >/dev/null 2>&1 ||
      docker network create --internal --subnet 10.71.$n.0/24 $P-lan-$side >/dev/null
  done
  exists $P-server || docker run -d --name $P-server --network $P-wan --ip 198.18.0.2 \
    -v /:/host:ro alpine sleep infinity >/dev/null
  exists $P-stun2 || docker run -d --name $P-stun2 --network $P-wan --ip 198.18.0.3 \
    -v /:/host:ro alpine chroot /host "$NODE_BIN" "$LAB/stun.mjs" 3478 >/dev/null
  if ! exists $P-turn; then
    docker run -d --name $P-turn --network $P-wan --ip 198.18.0.4 alpine sleep infinity >/dev/null
    docker exec $P-turn apk add --no-cache -q coturn >/dev/null
    docker exec -d $P-turn turnserver -n --listening-ip=198.18.0.4 --listening-port=3478 \
      --relay-ip=198.18.0.4 --external-ip=198.18.0.4 --min-port=49160 --max-port=49200 \
      --use-auth-secret --static-auth-secret=lab-turn-secret --realm=lab --no-tls --no-dtls \
      --no-cli --fingerprint
  fi
  for side in a b; do
    local n; n=$(net $side)
    if ! exists $P-nat-$side; then
      docker run -d --name $P-nat-$side --network $P-wan --ip 198.18.0.1$n --cap-add NET_ADMIN \
        --sysctl net.ipv4.ip_forward=1 alpine sleep infinity >/dev/null
      docker network connect --ip 10.71.$n.254 $P-lan-$side $P-nat-$side
      docker exec $P-nat-$side apk add --no-cache -q iptables iproute2-tc conntrack-tools >/dev/null
    fi
    if ! exists $P-device-$side; then
      docker run -d --name $P-device-$side --network $P-lan-$side --ip 10.71.$n.2 \
        --cap-add NET_ADMIN -v /:/host:ro -v "$RESULTS:/host/tmp" alpine sleep infinity >/dev/null
      docker exec $P-device-$side sh -c "ip route del default 2>/dev/null; ip route add default via 10.71.$n.254"
    fi
  done
  echo "NAT lab is up."
}

down() {
  docker rm -f $P-device-a $P-device-b $P-nat-a $P-nat-b $P-server $P-stun2 $P-turn >/dev/null 2>&1
  docker network rm $P-lan-a $P-lan-b $P-wan >/dev/null 2>&1
  echo "NAT lab removed."
}

exists() { docker inspect "$1" >/dev/null 2>&1; }
net() { [ "$1" = a ] && echo 1 || echo 2; }

# nat <a|b> <home|strict|no-udp>
#   home    endpoint-independent mapping, filtered inbound (most home routers)
#   strict  a new public port per destination ("symmetric", common on mobile networks)
#   no-udp  UDP blocked outright (strict office/school/public Wi-Fi)
nat() {
  local side=$1 mode=$2 n c=$P-nat-$1
  n=$(net "$side")
  local wan lan
  wan=$(docker exec $c sh -c "ip -o -4 addr show | awk '/198\\.18\\.0\\./{print \$2; exit}'")
  lan=$(docker exec $c sh -c "ip -o -4 addr show | awk '/10\\.71\\./{print \$2; exit}'")
  local masquerade="-j MASQUERADE"
  [ "$mode" = strict ] && masquerade="-j MASQUERADE --random-fully"
  docker exec $c sh -c "
    iptables -F; iptables -t nat -F; conntrack -F >/dev/null 2>&1
    for d in \$(ls /sys/class/net | grep -v lo); do tc qdisc del dev \$d root 2>/dev/null; done
    ip addr del 198.18.0.2$n/24 dev $wan 2>/dev/null
    iptables -t nat -A POSTROUTING -s 10.71.$n.0/24 -o $wan $masquerade
    iptables -P FORWARD DROP
    iptables -A FORWARD -i $lan -o $wan -j ACCEPT
    iptables -A FORWARD -i $wan -o $lan -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    iptables -A INPUT -i $wan -p udp -m conntrack --ctstate NEW -j DROP"
  [ "$mode" = no-udp ] && docker exec $c iptables -I FORWARD 1 -i "$lan" -o "$wan" -p udp -j DROP
  true
}

# throttle <a|b> <rate>: limits the NAT's links, so transfers last long enough to interfere with.
throttle() {
  docker exec $P-nat-$1 sh -c "for d in \$(ls /sys/class/net | grep -v lo); do
    tc qdisc replace dev \$d root tbf rate $2 burst 64kb latency 400ms; done"
}

# renumber <a|b>: the network gets a new public address mid-session (Wi-Fi → mobile data).
renumber() {
  local n c=$P-nat-$1
  n=$(net "$1")
  docker exec $c sh -c "wan=\$(ip -o -4 addr show | awk '/198\\.18\\.0\\.1/{print \$2; exit}')
    ip addr add 198.18.0.2$n/24 dev \$wan
    iptables -t nat -F POSTROUTING
    iptables -t nat -A POSTROUTING -s 10.71.$n.0/24 -o \$wan -j SNAT --to-source 198.18.0.2$n
    conntrack -F >/dev/null 2>&1"
}

# server <ENV=value …>: (re)starts preprati. and the first STUN server.
server() {
  docker exec $P-server sh -c "pkill -f dist/server/index.js; pkill -f stun.mjs" >/dev/null 2>&1
  sleep 0.3
  docker exec -d $P-server chroot /host "$NODE_BIN" "$LAB/stun.mjs" 3478
  docker exec -d $P-server chroot /host /usr/bin/env NODE_ENV=production HOST=0.0.0.0 PORT=4400 \
    SERVE_STATIC=true STATIC_DIR="$PROJECT/dist/client" LOG_LEVEL=warn RATE_LIMIT_API=100000 \
    SESSION_MAX_PER_IP=1000 RATE_LIMIT_JOIN_FAILURES=1000 RATE_LIMIT_WS_CONNECT=1000 \
    WS_MAX_CONNECTIONS_PER_IP=1000 STUN_URLS=$STUN_URLS "$@" \
    sh -c "cd '$PROJECT' && exec '$NODE_BIN' dist/server/index.js"
  for _ in $(seq 1 50); do
    docker exec $P-server wget -q -O /dev/null http://127.0.0.1:4400/api/health 2>/dev/null && return
    sleep 0.2
  done
  echo "The app did not start in the lab."; exit 1
}

# devices <tag> <payload MB> [retry]: starts both devices in the background.
devices() {
  local tag=$1
  rm -f "$RESULTS"/*-"$tag"* "$RESULTS"/code-"$tag"
  cp "$LAB/client.mjs" "$RESULTS/client.mjs"
  for side in a b; do
    local role; role=$([ $side = a ] && echo host || echo guest)
    # Root only for chroot; the browser runs as the invoking user, so results stay theirs.
    docker exec $P-device-$side chroot /host /usr/bin/setpriv --reuid="$(id -u)" --regid="$(id -g)" \
      --clear-groups /usr/bin/env HOME=/tmp/home-$side PROJECT="$PROJECT" CHROME_BIN="$CHROME_BIN" \
      sh -c "mkdir -p /tmp/home-$side && exec '$NODE_BIN' /tmp/client.mjs $role $APP $tag 60 $2 ${3:-}" &
    eval "pid_$side=$!"
  done
}
wait_devices() { wait "$pid_a" "$pid_b" 2>/dev/null; }
report() { "$NODE_BIN" "$LAB/report.mjs" "$RESULTS" "$1" ${ICE:+--ice}; }

scenarios() {
  local list=${*:-1 2 3 4 5 6 7}
  for s in $list; do
    echo
    case $s in
    1) echo "1. Two home networks (typical routers), HTTP signaling as on Vercel"
       nat a home; nat b home; server "${HTTP_SIGNALING[@]}"
       devices s1 2; wait_devices; report s1 ;;
    2) echo "2. A home network and a strict NAT (as on many mobile networks), no relay"
       nat a home; nat b strict; server "${HTTP_SIGNALING[@]}"
       devices s2 2; wait_devices; report s2 ;;
    3) echo "3. Device A's network blocks UDP (strict office/school Wi-Fi), no relay"
       nat a no-udp; nat b home; server "${HTTP_SIGNALING[@]}"
       devices s3 2; wait_devices; report s3 ;;
    4) echo "4. Strict NAT fails, B moves to a home network, B presses \"Try again\""
       nat a home; nat b strict; server "${HTTP_SIGNALING[@]}"
       devices s4 2 retry
       for _ in $(seq 1 300); do
         [ -f "$RESULTS/failed-s4-host" ] && [ -f "$RESULTS/failed-s4-guest" ] && break; sleep 0.2
       done
       nat b home; touch "$RESULTS/go-retry-s4"
       wait_devices; report s4 ;;
    5) echo "5. A's network changes public address mid-transfer (Wi-Fi → mobile data)"
       nat a home; nat b home; throttle a 16mbit; throttle b 16mbit; server "${HTTP_SIGNALING[@]}"
       devices s5 30
       for _ in $(seq 1 300); do [ -f "$RESULTS/sending-s5" ] && break; sleep 0.2; done
       sleep 4; renumber a; echo "   (A now leaves from 198.18.0.21)"
       wait_devices; report s5 ;;
    6) echo "6. Strict NAT on both sides, optional TURN relay configured"
       nat a strict; nat b strict
       server "${HTTP_SIGNALING[@]}" "TURN_URLS=turn:198.18.0.4:3478?transport=udp" \
         TURN_SECRET=lab-turn-secret
       devices s6 2; wait_devices; report s6 ;;
    7) echo "7. Two home networks, WebSocket signaling (self-hosted Node server)"
       nat a home; nat b home; server
       devices s7 2; wait_devices; report s7 ;;
    *) echo "Unknown scenario $s" ;;
    esac
  done
}

case "${1:-}" in
up | down | scenarios) cmd=$1; shift; $cmd "$@" ;;
*) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
