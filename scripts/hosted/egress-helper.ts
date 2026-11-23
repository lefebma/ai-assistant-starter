/**
 * The root half of egress on a hosted box (card #307).
 *
 * Until 1.84.6 the tools cgroup sat inside havn.service, which the assistant's
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
 * Both files are written by enable-egress (and cloud-init) to root-owned
 * /usr/local/lib/havn and run with root-owned /usr/bin/python3: nothing the
 * assistant's user can edit ever runs as root.
 */

export const TOOLS_CGROUP_REL = 'havn-tools'
export const TOOLS_CGROUP = `/sys/fs/cgroup/${TOOLS_CGROUP_REL}`
export const HELPER_DIR = '/usr/local/lib/havn'
export const JOIN_PATH = `${HELPER_DIR}/tools-join`
export const DAEMON_PATH = `${HELPER_DIR}/egressd.py`
export const SOCKET_DIR = '/run/havn-egress'
export const SOCKET_PATH = `${SOCKET_DIR}/sock`
export const UNIT_CGROUP = '/system.slice/havn.service'

/** The root service. Python because Node cannot read a unix socket's peer credentials. */
export const EGRESSD_PY = `#!/usr/bin/python3 -IS
# havn-egressd (card #307): moves the caller's parent into the tools cgroup. Written by enable-egress.
import os, pwd, signal, socket, struct, threading

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

def handle(conn):
    try:
        conn.settimeout(3)
        pid, uid, _gid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        req = conn.recv(512).decode('utf-8', 'replace').strip()
        if uid != HAVN.pw_uid:
            reply = 'no: only the assistant may ask'
        elif req == 'join':
            reply = join(pid)
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
ProtectHome=yes
PrivateTmp=yes
PrivateNetwork=yes
RestrictAddressFamilies=AF_UNIX

[Install]
WantedBy=multi-user.target
`
