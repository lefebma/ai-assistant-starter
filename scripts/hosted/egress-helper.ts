/**
 * The root half of egress on a hosted box (card #307).
 *
 * Before 1.86.0 the tools cgroup sat inside havn.service, which the assistant's
 * user owned (Delegate=yes) so it could put its tools there. Anything a tool
 * ran, as that same user, could therefore write its own pid back into
 * havn.service/cgroup.procs, leave the fence and reach the internet.
 *
 * Now the tools cgroup is /sys/fs/cgroup/havn-tools, at the top of the tree.
 * Moving a process into or out of it needs write access to the root cgroup's
 * cgroup.procs, which only root has. A small root service, havn-egressd, does
 * the one move the assistant needs: it puts the caller's parent (the shell
 * that is about to exec a tool) into havn-tools. It never moves anything out.
 *
 * It knows who is asking from the socket itself (SO_PEERCRED), not from what
 * the caller says, and it agrees only when:
 *   - the caller runs as havn
 *   - its parent runs as havn (every uid) and sits in havn.service, or is
 *     already in havn-tools
 * So a tool can at most move its own parent, which is already fenced, and
 * nothing can ask it to move a process out.
 *
 * Card #306: it also adds a site to, or takes one off, the read list in
 * /etc/havn/egress.env, for the assistant's own process only (its cgroup is
 * havn.service itself and it runs the service's node), never for a tool.
 * Adding needs EGRESS_APPROVER=owner in that same root-owned file, so only
 * whoever runs the box can let the owner approve sites. One plain public
 * host name at a time: no address, wildcard, port, group or internal name.
 *
 * Both files are written by enable-egress (and cloud-init) to root-owned
 * /usr/local/lib/havn and run with root-owned /usr/bin/python3: nothing the
 * assistant's user can edit ever runs as root.
 */

export const TOOLS_CGROUP_REL = 'havn-tools'
export const TOOLS_CGROUP = `/sys/fs/cgroup/${TOOLS_CGROUP_REL}`
export const HELPER_DIR = '/usr/local/lib/havn'
export const JOIN_PATH = `${HELPER_DIR}/tools-join`
export const DAEMON_PATH = `${HELPER_DIR}/egressd.py`
import { EGRESS_SOCKET } from '../../src/egress/hosted.js'

export const SOCKET_DIR = '/run/havn-egress'
export const SOCKET_PATH = EGRESS_SOCKET
export const UNIT_CGROUP = '/system.slice/havn.service'
export const EGRESS_ENV_FILE = '/etc/havn/egress.env'

/** The root service. Python because Node cannot read a unix socket's peer credentials. */
export const EGRESSD_PY = `#!/usr/bin/python3 -IS
# havn-egressd (card #307): moves the caller's parent into the tools cgroup. Written by enable-egress.
import os, pwd, re, signal, socket, struct, threading

SOCK = ${JSON.stringify(SOCKET_PATH)}
TOOLS = ${JSON.stringify(TOOLS_CGROUP)}
TOOLS_REL = ${JSON.stringify('/' + TOOLS_CGROUP_REL)}
UNIT = ${JSON.stringify(UNIT_CGROUP)}
HAVN = pwd.getpwnam('havn')
SHELL = os.path.realpath('/bin/sh')
SLOTS = threading.BoundedSemaphore(32)

def cgroup_of(pid):
    with open('/proc/%d/cgroup' % pid) as f:
        for line in f:
            if line.startswith('0::'):
                return line[3:].strip()
    return ''

def uids_of(pid):
    with open('/proc/%d/status' % pid) as f:
        for line in f:
            if line.startswith('Uid:'):
                return set(int(x) for x in line.split()[1:])
    return set()

def ppid_of(pid):
    with open('/proc/%d/stat' % pid) as f:
        s = f.read()
    return int(s[s.rindex(')') + 2:].split()[1])

def started(pid):
    with open('/proc/%d/stat' % pid) as f:
        s = f.read()
    return s[s.rindex(')') + 2:].split()[19]

def join(peer):
    parent = ppid_of(peer)
    if parent <= 1:
        return 'no: the parent does not run as havn'
    # Only the wrapper shell, about to exec a tool, is ever moved. A tool that
    # execs this helper itself has the assistant as its parent, which must
    # never be put in the fence.
    try:
        exe = os.readlink('/proc/%d/exe' % parent)
    except OSError:
        return 'no: the parent is gone'
    if exe != SHELL:
        return "no: only the assistant's tool shell may be moved"
    # Hold the parent so its pid cannot be reused while it is checked, and
    # check it is the same process (start time) after the move as before.
    fd = os.pidfd_open(parent)
    try:
        born = started(parent)
        if uids_of(parent) != {HAVN.pw_uid}:
            return 'no: the parent does not run as havn'
        cg = cgroup_of(parent)
        if cg == TOOLS_REL:
            return 'ok'
        if cg != UNIT and not cg.startswith(UNIT + '/'):
            return 'no: the parent is not part of the assistant'
        signal.pidfd_send_signal(fd, 0)
        with open(TOOLS + '/cgroup.procs', 'w') as f:
            f.write(str(parent))
        if started(parent) != born or ppid_of(peer) != parent:
            return 'no: the parent changed while it was moved'
        return 'ok'
    finally:
        os.close(fd)

# --- sites approved from chat (card #306) ---
ENV_FILE = ${JSON.stringify(EGRESS_ENV_FILE)}
NODE = os.path.realpath('/usr/bin/node')
LABEL = re.compile(r'[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?')
INTERNAL = re.compile(r'(^|\\.)(localhost|local|internal|lan|home\\.arpa|intranet|corp)\\Z')

def approvable(h):
    # fullmatch throughout: '$' also matches before a trailing newline, and a
    # newline must never reach the settings file.
    h = h.strip().lower().rstrip('.')
    if not h or len(h) > 253 or not h.isascii() or not h.isprintable() or ' ' in h:
        return None
    if ':' in h or re.fullmatch(r'[0-9.]+', h):
        return None
    labels = h.split('.')
    if len(labels) < 2 or not all(LABEL.fullmatch(l) for l in labels):
        return None
    if labels[-1].isdigit() or not re.fullmatch(r'[a-z][a-z0-9-]*[a-z0-9]|[a-z]{2,}', labels[-1]):
        return None
    if INTERNAL.search(h):
        return None
    return h

def read_env():
    with open(ENV_FILE) as f:
        return f.read().split('\\n')

def setting(lines, key):
    for l in lines:
        if l.startswith(key + '='):
            return l[len(key) + 1:].strip()
    return ''

def hosts(v):
    return [x for x in re.split(r'[\\s,]+', v) if x]

def write_env(lines):
    tmp = ENV_FILE + '.new'
    with open(tmp, 'w') as f:
        f.write('\\n'.join(lines))
    os.chown(tmp, 0, 0)
    os.chmod(tmp, 0o644)
    os.replace(tmp, ENV_FILE)

LOCK = threading.Lock()

def change_read(op, host):
    with LOCK:
        lines = read_env()
        read = hosts(setting(lines, 'EGRESS_READ'))
        if op == 'allow':
            if setting(lines, 'EGRESS_APPROVER').lower() != 'owner':
                return 'no: sites on this box are approved by whoever runs it'
            if host in read or host in hosts(setting(lines, 'EGRESS_ALLOW')):
                return 'ok: already listed'
            read.append(host)
        else:
            if host not in read:
                return 'no: not on the read list'
            read = [x for x in read if x != host]
        if any(not x.isprintable() or not x.isascii() or ' ' in x for x in read):
            return 'no: the read list in the settings file is not plain host names'
        line = 'EGRESS_READ=' + ','.join(read)
        if any(l.startswith('EGRESS_READ=') for l in lines):
            lines = [line if l.startswith('EGRESS_READ=') else l for l in lines]
        else:
            lines.insert(len(lines) - 1 if lines and lines[-1] == '' else len(lines), line)
        write_env(lines)
        return 'ok'

def site(peer, op, arg):
    # Only the assistant itself, never one of its tools: its own process, in
    # its own cgroup, running the service's node. A tool is in havn-tools and
    # cannot leave it, so it can never ask.
    if cgroup_of(peer) != UNIT:
        return 'no: only the assistant itself may change its sites'
    try:
        if os.readlink('/proc/%d/exe' % peer) != NODE:
            return 'no: only the assistant itself may change its sites'
    except OSError:
        return 'no: the caller is gone'
    host = approvable(arg)
    if not host:
        return 'no: not a site name that can be approved'
    r = change_read(op, host)
    print('havn-egressd: %s %s -> %s' % (op, host, r), flush=True)
    return r

def handle(conn):
    try:
        conn.settimeout(3)
        pid, uid, _gid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        req = conn.recv(512).decode('utf-8', 'replace').strip()
        if uid != HAVN.pw_uid:
            reply = 'no: only the assistant may ask'
        elif req == 'join':
            reply = join(pid)
        elif req.startswith('allow ') or req.startswith('remove '):
            op, _, arg = req.partition(' ')
            reply = site(pid, op, arg)
        else:
            reply = 'no: unknown request'
    except Exception as e:
        reply = 'no: ' + type(e).__name__
    try:
        conn.sendall((reply + '\\n').encode())
    except Exception:
        pass
    conn.close()

def run(conn):
    try:
        handle(conn)
    finally:
        SLOTS.release()

def main():
    os.makedirs(TOOLS, exist_ok=True)
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    s.bind(SOCK)
    os.umask(old)
    os.chown(SOCK, 0, HAVN.pw_gid)
    os.chmod(SOCK, 0o660)
    s.listen(64)
    while True:
        conn, _ = s.accept()
        if not SLOTS.acquire(blocking=False):
            conn.close()
            continue
        threading.Thread(target=run, args=(conn,), daemon=True).start()

main()
`

/** Run by the shell that is about to exec a tool: asks havn-egressd to move that shell. */
export const JOIN_PY = `#!/usr/bin/python3 -IS
# tools-join (card #307): asks havn-egressd to move this process's parent into the tools cgroup.
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(${JSON.stringify(SOCKET_PATH)})
    s.sendall(b'join\\n')
    r = s.recv(256).decode('utf-8', 'replace').strip()
except Exception as e:
    r = 'no: ' + type(e).__name__
if r != 'ok':
    sys.stderr.write('havn: could not join the tools group (%s); the command did not run\\n' % r)
    sys.exit(1)
`

export const EGRESSD_UNIT = `[Unit]
Description=Havn egress helper (moves the assistant's tools into their cgroup)
Before=havn.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 -I -S ${DAEMON_PATH}
Restart=always
RestartSec=1
RuntimeDirectory=havn-egress
RuntimeDirectoryMode=0755
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/etc/havn
ProtectHome=yes
PrivateTmp=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
`
