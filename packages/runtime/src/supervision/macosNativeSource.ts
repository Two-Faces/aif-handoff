/* Trusted Objective-C helper, compiled with the installed macOS SDK. */
export const macosNativeSource = String.raw`#define _DARWIN_C_SOURCE
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/message.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Native process control only. Commands and environment are data on a private
 * socket; the target inherits only stdin/stdout/stderr, never the control FD. */
struct unique_info { uint8_t image[16]; uint64_t unique, parent_unique; int32_t version, parent_version; uint64_t reserved[2]; };
struct identity_info { struct proc_bsdinfo bsd; struct unique_info unique; };
struct coalitions_info { uint64_t resource, jetsam, reserved[3]; };
_Static_assert(sizeof(struct unique_info) == 56, "Unique identity ABI");
_Static_assert(sizeof(struct coalitions_info) == 40, "Coalition ABI");
typedef int (*signal_token_fn)(audit_token_t *, int);
typedef int (*usage_fn)(uint64_t, void *, size_t);
typedef int (*spawn_chdir_fn)(posix_spawn_file_actions_t *, const char *);
static signal_token_fn token_signal;
static usage_fn resource_usage;
static spawn_chdir_fn spawn_chdir;
static int control_fd = -1;
static NSMutableData *wire;
static uint64_t host_coalition;
static bool can_drain;

static void fail(NSString *stage, int error) {
    @throw [NSException exceptionWithName:@"AifNativeFailure" reason:stage
        userInfo:@{@"nativeCode": @(error)}];
}
static uint64_t milliseconds(void) {
    struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t) != 0) fail(@"clock", errno);
    return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000;
}
/* Prefix private helpers: Foundation also imports SDK typedefs such as decimal. */
static NSString *aif_u64_string(uint64_t n) { return [NSString stringWithFormat:@"%" PRIu64, n]; }
static bool text(id value) {
    if (![value isKindOfClass:NSString.class]) return false;
    NSString *s = value; const char *p = s.UTF8String;
    return p && s.length < 32768 && strlen(p) == [s lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
}
static uint64_t number(id value) {
    if (!text(value) || [(NSString *)value length] == 0) fail(@"identity_shape", EINVAL);
    const char *p = [(NSString *)value UTF8String];
    for (const char *c = p; *c; ++c) if (*c < '0' || *c > '9') fail(@"identity_shape", EINVAL);
    errno = 0; char *end = NULL; uint64_t n = strtoull(p, &end, 10);
    if (errno || !end || *end) fail(@"identity_shape", EINVAL);
    return n;
}
static uint32_t uint_value(id value) {
    if (![value isKindOfClass:NSNumber.class]) fail(@"identity_shape", EINVAL);
    double n = [value doubleValue];
    if (n < 0 || n > UINT32_MAX || n != (double)[value unsignedLongLongValue]) fail(@"identity_shape", EINVAL);
    return [value unsignedIntValue];
}
static NSDictionary *json(NSData *data) {
    if (data.length > 1048576) fail(@"protocol_size", E2BIG);
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    if (![value isKindOfClass:NSDictionary.class]) fail(@"protocol_json", EINVAL);
    return value;
}
static void emit(NSDictionary *frame) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:frame options:0 error:NULL];
    if (!data) fail(@"protocol_json", EINVAL);
    if (control_fd < 0) {
        if (fwrite(data.bytes, 1, data.length, stdout) != data.length || fputc('\n', stdout) == EOF || fflush(stdout) != 0)
            fail(@"output", errno);
    } else {
        if (wire.length + data.length + 1 > 4194304) fail(@"output_overflow", E2BIG);
        [wire appendData:data]; [wire appendBytes:"\n" length:1];
    }
}
static NSString *boot_session(void) {
    char value[128] = {0}; size_t length = sizeof(value);
    if (sysctlbyname("kern.bootsessionuuid", value, &length, NULL, 0) != 0) fail(@"boot_identity", errno);
    if (!memchr(value, 0, sizeof(value))) fail(@"boot_identity", EPROTO);
    NSString *s = [NSString stringWithUTF8String:value];
    if (!s || ![[NSUUID alloc] initWithUUIDString:s]) fail(@"boot_identity", EPROTO);
    return s.lowercaseString;
}
static int inspect(pid_t pid, struct identity_info *i, struct coalitions_info *c) {
    struct identity_info again = {0}; memset(i, 0, sizeof(*i)); memset(c, 0, sizeof(*c)); errno = 0;
    if (proc_pidinfo(pid, 18, 0, i, sizeof(*i)) != (int)sizeof(*i)) return errno ? errno : EPROTO;
    if (i->bsd.pbi_pid != (uint32_t)pid || !i->unique.unique) return EPROTO;
    if (proc_pidinfo(pid, 20, 0, c, sizeof(*c)) != (int)sizeof(*c)) return errno ? errno : EPROTO;
    if (proc_pidinfo(pid, 18, 0, &again, sizeof(again)) != (int)sizeof(again)) return errno ? errno : EPROTO;
    if (i->unique.unique != again.unique.unique || i->unique.version != again.unique.version) return EAGAIN;
    return 0;
}
static uint64_t born(struct identity_info *i) {
    if (i->bsd.pbi_start_tvsec > UINT64_MAX / 1000000 || i->bsd.pbi_start_tvusec >= 1000000) fail(@"birth", EPROTO);
    return i->bsd.pbi_start_tvsec * 1000000 + i->bsd.pbi_start_tvusec;
}
static NSDictionary *identity(pid_t pid) {
    struct identity_info i; struct coalitions_info c; int error = inspect(pid, &i, &c);
    if (error) fail(@"inspect", error);
    char image[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, image, sizeof(image)) <= 0) fail(@"image", errno ? errno : EPROTO);
    return @{@"pid": @(pid), @"uid": @(i.bsd.pbi_uid), @"birth": aif_u64_string(born(&i)),
        @"uniqueId": aif_u64_string(i.unique.unique), @"pidVersion": @((uint32_t)i.unique.version),
        @"coalitionId": aif_u64_string(c.resource), @"image": [NSString stringWithUTF8String:image],
        @"stopped": @(i.bsd.pbi_status == 4)};
}
static int counts(uint64_t coalition, uint64_t *started, uint64_t *exited) {
    uint64_t values[2] = {0}; errno = 0;
    if (resource_usage(coalition, values, sizeof(values)) != 0) return errno ? errno : EIO;
    if (values[1] > values[0]) return EPROTO;
    *started = values[0]; *exited = values[1]; return 0;
}
static int signal_identity(pid_t pid, struct identity_info *saved, uint64_t coalition, int signum) {
    struct identity_info now; struct coalitions_info c; int error = inspect(pid, &now, &c);
    if (error) return error;
    if (c.resource != coalition || now.bsd.pbi_uid != geteuid() ||
        now.unique.unique != saved->unique.unique || now.unique.version != saved->unique.version) return ESRCH;
    audit_token_t token = {{0}};
    token.val[1] = now.bsd.pbi_uid; token.val[2] = now.bsd.pbi_gid;
    token.val[3] = now.bsd.pbi_ruid; token.val[4] = now.bsd.pbi_rgid;
    token.val[5] = (uint32_t)pid; token.val[7] = (uint32_t)now.unique.version;
    return token_signal(&token, signum);
}
/* Enumeration is only a way to find targets; only native accounting proves
 * emptiness. A missed/inaccessible member cannot turn into a successful stop. */
static uint32_t drain(uint64_t coalition, pid_t preserve) {
    struct identity_info self; struct coalitions_info own;
    if (inspect(getpid(), &self, &own)) fail(@"drain_identity", EPROTO);
    if (coalition == 0 || ((preserve == 0) && coalition == own.resource)) fail(@"drain_scope", EINVAL);
    NSMutableSet<NSString *> *signalled = [NSMutableSet set]; uint64_t deadline = milliseconds() + 25000;
    while (true) {
        uint64_t started, exited; int error = counts(coalition, &started, &exited);
        if (error == ESRCH && preserve == 0) return (uint32_t)signalled.count;
        if (error) fail(@"drain_accounting", error);
        if (started - exited == (preserve ? 1u : 0u)) return (uint32_t)signalled.count;
        int capacity = proc_listpids(PROC_UID_ONLY, geteuid(), NULL, 0);
        if (capacity <= 0 || capacity > 4194304) fail(@"drain_enumeration", EPROTO);
        capacity += 4096;
        pid_t *pids = calloc(1, (size_t)capacity);
        if (!pids) fail(@"allocation", ENOMEM);
        int bytes = proc_listpids(PROC_UID_ONLY, geteuid(), pids, capacity);
        if (bytes < 0 || bytes > capacity) { free(pids); fail(@"drain_enumeration", EPROTO); }
        for (int k = 0; k < bytes / (int)sizeof(pid_t); ++k) {
            pid_t pid = pids[k]; if (pid <= 0 || pid == preserve) continue;
            struct identity_info i; struct coalitions_info c;
            if (inspect(pid, &i, &c) || c.resource != coalition || i.bsd.pbi_uid != geteuid()) continue;
            int result = signal_identity(pid, &i, coalition, SIGKILL);
            if (result == 0) [signalled addObject:aif_u64_string(i.unique.unique)];
        }
        free(pids);
        if (milliseconds() >= deadline) fail(@"drain_timeout", ETIMEDOUT);
        usleep(10000);
    }
}
static void check_saved_host(NSDictionary *saved) {
    if (![saved[@"bootSessionId"] isEqual:boot_session()] || uint_value(saved[@"hostUid"]) != geteuid())
        fail(@"recovery_boot_or_user", EINVAL);
    uint64_t coalition = number(saved[@"coalitionId"]);
    uint32_t pid = uint_value(saved[@"hostPid"]);
    if (!pid || pid > INT_MAX) fail(@"identity_shape", EINVAL);
    struct identity_info i; struct coalitions_info c; int error = inspect((pid_t)pid, &i, &c);
    if (error == ESRCH) return;
    if (error) fail(@"recovery_inspect", error);
    if (i.bsd.pbi_uid != geteuid() || c.resource != coalition ||
        i.unique.unique != number(saved[@"hostUniqueId"]) ||
        (uint32_t)i.unique.version != uint_value(saved[@"hostPidVersion"]) ||
        born(&i) != number(saved[@"hostBirth"])) fail(@"recovery_identity", EINVAL);
}
static void nonblocking(int fd) {
    if (fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) < 0 ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) fail(@"fd_flags", errno);
}
static void flush_wire(void) {
    if (!wire.length) return;
    ssize_t n = write(control_fd, wire.bytes, wire.length);
    if (n > 0) [wire replaceBytesInRange:NSMakeRange(0, (NSUInteger)n) withBytes:NULL length:0];
    else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) fail(@"control_write", errno);
}
static void flush_final(void) {
    uint64_t deadline = milliseconds() + 3000;
    while (wire.length) {
        flush_wire(); if (!wire.length) break;
        if (milliseconds() >= deadline) fail(@"control_timeout", ETIMEDOUT);
        struct pollfd p = {control_fd, POLLOUT, 0}; (void)poll(&p, 1, 20);
    }
}
static void validate_launch(NSDictionary *f) {
    if (!text(f[@"executable"]) || ![(NSString *)f[@"executable"] hasPrefix:@"/"] ||
        !text(f[@"cwd"]) || ![(NSString *)f[@"cwd"] hasPrefix:@"/"] ||
        ![f[@"args"] isKindOfClass:NSArray.class] || ![f[@"environment"] isKindOfClass:NSDictionary.class])
        fail(@"launch_shape", EINVAL);
    for (id arg in f[@"args"]) if (!text(arg)) fail(@"launch_shape", EINVAL);
    for (id key in f[@"environment"]) {
        if (!text(key) || [(NSString *)key length] == 0 || [(NSString *)key containsString:@"="] ||
            !text(f[@"environment"][key])) fail(@"launch_shape", EINVAL);
    }
}
static char **strings(NSArray<NSString *> *values) {
    char **result = calloc(values.count + 1, sizeof(char *));
    if (!result) fail(@"allocation", ENOMEM);
    for (NSUInteger i = 0; i < values.count; ++i) {
        result[i] = strdup(values[i].UTF8String);
        if (!result[i]) fail(@"allocation", ENOMEM);
    }
    return result;
}
static void free_strings(char **values) {
    for (size_t i = 0; values[i]; ++i) free(values[i]); free(values);
}
static pid_t create_child(NSDictionary *f, int *input, int *output, int *diagnostic) {
    validate_launch(f);
    struct stat executable;
    if (stat([(NSString *)f[@"executable"] UTF8String], &executable) != 0) fail(@"executable", errno);
    if (!S_ISREG(executable.st_mode) || (executable.st_mode & (S_ISUID | S_ISGID))) fail(@"privileged_executable", EPERM);
    int in[2], out[2], err[2];
    if (pipe(in) || pipe(out) || pipe(err)) fail(@"pipe", errno);
    posix_spawn_file_actions_t actions; posix_spawnattr_t attributes;
    int result = posix_spawn_file_actions_init(&actions);
    if (result) fail(@"spawn_actions", result);
    result = posix_spawnattr_init(&attributes);
    if (result) fail(@"spawn_attributes", result);
    #define SPAWN_CALL(call) do { int e = (call); if (e) fail(@"spawn_setup", e); } while (0)
    SPAWN_CALL(posix_spawn_file_actions_adddup2(&actions, in[0], STDIN_FILENO));
    SPAWN_CALL(posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO));
    SPAWN_CALL(posix_spawn_file_actions_adddup2(&actions, err[1], STDERR_FILENO));
    SPAWN_CALL(spawn_chdir(&actions, [(NSString *)f[@"cwd"] UTF8String]));
    sigset_t empty, defaults; sigemptyset(&empty); sigfillset(&defaults);
    sigdelset(&defaults, SIGKILL); sigdelset(&defaults, SIGSTOP);
    SPAWN_CALL(posix_spawnattr_setsigmask(&attributes, &empty));
    SPAWN_CALL(posix_spawnattr_setsigdefault(&attributes, &defaults));
    SPAWN_CALL(posix_spawnattr_setflags(&attributes, POSIX_SPAWN_START_SUSPENDED |
        POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF));
    NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithObject:f[@"executable"]];
    [arguments addObjectsFromArray:f[@"args"]];
    NSMutableArray<NSString *> *environment = [NSMutableArray array];
    for (NSString *key in f[@"environment"])
        [environment addObject:[NSString stringWithFormat:@"%@=%@", key, f[@"environment"][key]]];
    char **argv = strings(arguments), **envp = strings(environment);
    pid_t pid = 0;
    result = posix_spawn(&pid, [(NSString *)f[@"executable"] UTF8String], &actions, &attributes, argv, envp);
    free_strings(argv); free_strings(envp);
    posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
    close(in[0]); close(out[1]); close(err[1]);
    if (result) { close(in[1]); close(out[0]); close(err[0]); fail(@"spawn", result); }
    nonblocking(in[1]); nonblocking(out[0]); nonblocking(err[0]);
    *input = in[1]; *output = out[0]; *diagnostic = err[0]; return pid;
}
static uint32_t status_code(int status) {
    if (WIFEXITED(status)) return (uint32_t)WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return (uint32_t)(128 + WTERMSIG(status));
    fail(@"child_status", EPROTO); return 0;
}
static void host(NSString *root) {
    struct stat directory;
    if (lstat(root.UTF8String, &directory) || !S_ISDIR(directory.st_mode) ||
        directory.st_uid != geteuid() || (directory.st_mode & 077)) fail(@"directory", EACCES);
    NSString *idPart = [root.lastPathComponent substringFromIndex:[@"aif-supervisor-" length]];
    if (![[NSUUID alloc] initWithUUIDString:idPart] ||
        ![root isEqual:[@"/private/tmp/aif-supervisor-" stringByAppendingString:idPart]]) fail(@"directory", EINVAL);
    NSString *socketPath = [root stringByAppendingPathComponent:@"control.sock"];
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    address.sun_len = (uint8_t)sizeof(address);
    if (strlen(socketPath.UTF8String) >= sizeof(address.sun_path)) fail(@"socket_path", ENAMETOOLONG);
    strcpy(address.sun_path, socketPath.UTF8String);
    control_fd = socket(AF_UNIX, SOCK_STREAM, 0); if (control_fd < 0) fail(@"socket", errno);
    if (connect(control_fd, (struct sockaddr *)&address, sizeof(address))) fail(@"connect", errno);
    uid_t peerUid; gid_t peerGid;
    if (getpeereid(control_fd, &peerUid, &peerGid) || peerUid != geteuid()) fail(@"peer", EACCES);
    nonblocking(control_fd); wire = [NSMutableData data];
    NSDictionary *self = identity(getpid()); host_coalition = number(self[@"coalitionId"]);
    uint64_t initial, dead;
    int e = counts(host_coalition, &initial, &dead);
    if (e || initial - dead != 1) fail(@"host_not_isolated", e ? e : EPROTO);
    emit(@{@"kind": @"hello", @"identity": self, @"bootSessionId": boot_session(),
        @"started": aif_u64_string(initial), @"exited": aif_u64_string(dead), @"id": idPart});
    NSMutableData *buffer = [NSMutableData data], *pendingInput = [NSMutableData data];
    pid_t child = 0; int input = -1, output = -1, diagnostic = -1, status = 0;
    bool started = false, inputEnded = false, rootExited = false, stopping = false;
    NSString *reason = @"completed"; struct identity_info prepared = {0};
    while (!stopping) {
        @autoreleasepool {
            struct pollfd polls[4] = {
                {control_fd, (short)(POLLIN | (wire.length ? POLLOUT : 0)), 0},
                {output, POLLIN, 0}, {diagnostic, POLLIN, 0},
                {input, pendingInput.length ? POLLOUT : 0, 0}
            };
            if (poll(polls, 4, 20) < 0 && errno != EINTR) fail(@"poll", errno);
            if (polls[0].revents & (POLLERR | POLLNVAL)) fail(@"control_lost", EPIPE);
            if (polls[0].revents & POLLOUT) flush_wire();
            if (polls[0].revents & (POLLIN | POLLHUP)) {
                char bytes[65536]; ssize_t n = read(control_fd, bytes, sizeof(bytes));
                if (n == 0) { stopping = true; reason = @"channel_closed"; }
                else if (n < 0 && errno != EAGAIN && errno != EINTR) fail(@"control_read", errno);
                else if (n > 0) [buffer appendBytes:bytes length:(NSUInteger)n];
                if (buffer.length > 1048576) fail(@"protocol_size", E2BIG);
                while (!stopping) {
                    const void *newline = memchr(buffer.bytes, '\n', buffer.length);
                    if (!newline) break;
                    NSUInteger size = (const uint8_t *)newline - (const uint8_t *)buffer.bytes;
                    NSDictionary *f = json([buffer subdataWithRange:NSMakeRange(0, size)]);
                    [buffer replaceBytesInRange:NSMakeRange(0, size + 1) withBytes:NULL length:0];
                    if ([f[@"kind"] isEqual:@"launch"] && child == 0) {
                        uint64_t now, exited; int error = counts(host_coalition, &now, &exited);
                        if (error || now != initial || exited != dead) fail(@"host_baseline_changed", error ? error : EPROTO);
                        can_drain = true;
                        child = create_child(f, &input, &output, &diagnostic);
                        struct coalitions_info c; error = inspect(child, &prepared, &c);
                        if (error || c.resource != host_coalition || prepared.bsd.pbi_status != 4)
                            fail(@"child_not_suspended", error ? error : EPROTO);
                        emit(@{@"kind": @"prepared", @"identity": identity(child)});
                    } else if ([f[@"kind"] isEqual:@"start"] && child && !started) {
                        int error = signal_identity(child, &prepared, host_coalition, SIGCONT);
                        if (error) fail(@"resume", error);
                        started = true; emit(@{@"kind": @"started"});
                    } else if ([f[@"kind"] isEqual:@"stop"]) {
                        stopping = true; reason = @"cancelled"; break;
                    } else if ([f[@"kind"] isEqual:@"input"] && started && !inputEnded && text(f[@"bytes"])) {
                        NSData *bytes = [[NSData alloc] initWithBase64EncodedString:f[@"bytes"] options:0];
                        if (!bytes || bytes.length > 65536 || pendingInput.length + bytes.length > 4194304) fail(@"input_size", E2BIG);
                        [pendingInput appendData:bytes];
                    } else if ([f[@"kind"] isEqual:@"endInput"] && started && !inputEnded) {
                        inputEnded = true;
                    } else fail(@"protocol_state", EPROTO);
                }
            }
            for (int stream = 1; stream <= 2; ++stream) {
                int fd = stream == 1 ? output : diagnostic;
                if (fd < 0 || !(polls[stream].revents & (POLLIN | POLLHUP))) continue;
                uint8_t bytes[16384]; ssize_t n = read(fd, bytes, sizeof(bytes));
                if (n > 0) emit(@{@"kind": @"output", @"stream": stream == 1 ? @"stdout" : @"stderr",
                    @"bytes": [[NSData dataWithBytes:bytes length:(NSUInteger)n] base64EncodedStringWithOptions:0]});
                else if (n == 0) { close(fd); if (stream == 1) output = -1; else diagnostic = -1; }
                else if (errno != EAGAIN && errno != EINTR) fail(@"target_output", errno);
            }
            if (input >= 0 && pendingInput.length && (polls[3].revents & POLLOUT)) {
                ssize_t n = write(input, pendingInput.bytes, pendingInput.length);
                if (n > 0) [pendingInput replaceBytesInRange:NSMakeRange(0, (NSUInteger)n) withBytes:NULL length:0];
                else if (n < 0 && errno == EPIPE) { close(input); input = -1; [pendingInput setLength:0]; }
                else if (n < 0 && errno != EAGAIN && errno != EINTR) fail(@"target_input", errno);
            }
            if (input >= 0 && inputEnded && !pendingInput.length) { close(input); input = -1; }
            if (child) {
                pid_t observed = waitpid(child, &status, WNOHANG);
                if (observed == child) { rootExited = true; stopping = true; }
                else if (observed < 0 && errno != EINTR) fail(@"waitpid", errno);
            }
        }
    }
    uint32_t killed = can_drain ? drain(host_coalition, getpid()) : 0;
    if (child && !rootExited) {
        if (waitpid(child, &status, 0) != child) fail(@"waitpid", errno);
        rootExited = true;
    }
    /* All descendants are gone. Drain buffered target output before the trusted
     * stop frame; no target byte is interpreted as a control command. */
    for (int stream = 0; stream < 2; ++stream) {
        int fd = stream == 0 ? output : diagnostic;
        if (fd < 0) continue;
        while (true) {
            uint8_t bytes[16384]; ssize_t n = read(fd, bytes, sizeof(bytes));
            if (n <= 0) break;
            emit(@{@"kind": @"output", @"stream": stream == 0 ? @"stdout" : @"stderr",
                @"bytes": [[NSData dataWithBytes:bytes length:(NSUInteger)n] base64EncodedStringWithOptions:0]});
            flush_wire();
        }
        close(fd);
    }
    if (input >= 0) close(input);
    if (child && ![reason isEqual:@"channel_closed"]) {
        emit(@{@"kind": @"stopped", @"exitCode": @(status_code(status)),
            @"terminatedProcesses": @(killed), @"reason": reason});
        flush_final();
    }
    close(control_fd); control_fd = -1;
}
int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    @autoreleasepool {
        @try {
            token_signal = (signal_token_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
            resource_usage = (usage_fn)dlsym(RTLD_DEFAULT, "coalition_info_resource_usage");
            spawn_chdir = (spawn_chdir_fn)dlsym(RTLD_DEFAULT, "posix_spawn_file_actions_addchdir");
            if (!spawn_chdir) spawn_chdir = (spawn_chdir_fn)dlsym(RTLD_DEFAULT, "posix_spawn_file_actions_addchdir_np");
            if (!token_signal || !resource_usage || !spawn_chdir) fail(@"native_symbols", ENOTSUP);
            if (argc == 2 && strcmp(argv[1], "capabilities") == 0) {
                struct identity_info self; struct coalitions_info c;
                if (inspect(getpid(), &self, &c)) fail(@"audit_probe", EPROTO);
                audit_token_t stale = {{0}};
                stale.val[1] = self.bsd.pbi_uid; stale.val[2] = self.bsd.pbi_gid;
                stale.val[3] = self.bsd.pbi_ruid; stale.val[4] = self.bsd.pbi_rgid;
                stale.val[5] = (uint32_t)getpid(); stale.val[7] = (uint32_t)self.unique.version ^ UINT32_C(0x80000000);
                if (token_signal(&stale, SIGCONT) != ESRCH) fail(@"audit_fence_unavailable", EPROTO);
                emit(@{@"kind": @"capabilities", @"bootSessionId": boot_session(), @"uid": @(geteuid()),
                    @"identity": identity(getpid())}); return 0;
            }
            if (argc == 2 && strcmp(argv[1], "peer") == 0) {
                audit_token_t peer = {{0}}; socklen_t size = sizeof(peer);
                uid_t peerUid; gid_t peerGid;
                if (getpeereid(3, &peerUid, &peerGid) || peerUid != geteuid()) fail(@"peer_credentials", EACCES);
                if (getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &peer, &size) || size != sizeof(peer)) fail(@"peer_token", errno ? errno : EPROTO);
                if (!peer.val[5] || peer.val[5] > INT_MAX || peer.val[1] != geteuid()) fail(@"peer_token", EACCES);
                NSDictionary *observed = identity((pid_t)peer.val[5]);
                if (uint_value(observed[@"pidVersion"]) != peer.val[7] || uint_value(observed[@"uid"]) != peerUid)
                    fail(@"peer_changed", EAGAIN);
                emit(@{@"kind": @"peer", @"identity": observed}); return 0;
            }
            if (argc == 3 && strcmp(argv[1], "identity") == 0) {
                uint64_t pid = number([NSString stringWithUTF8String:argv[2]]);
                if (!pid || pid > INT_MAX) fail(@"pid", EINVAL);
                emit(@{@"kind": @"identity", @"identity": identity((pid_t)pid)}); return 0;
            }
            if (argc == 3 && strcmp(argv[1], "usage") == 0) {
                uint64_t coalition = number([NSString stringWithUTF8String:argv[2]]), started, exited;
                int error = counts(coalition, &started, &exited);
                if (error) fail(@"usage", error);
                emit(@{@"kind": @"usage", @"started": aif_u64_string(started), @"exited": aif_u64_string(exited),
                    @"active": aif_u64_string(started - exited)}); return 0;
            }
            if (argc == 3 && strcmp(argv[1], "recover") == 0) {
                NSDictionary *saved = json([[NSString stringWithUTF8String:argv[2]] dataUsingEncoding:NSUTF8StringEncoding]);
                check_saved_host(saved);
                uint64_t coalition = number(saved[@"coalitionId"]);
                uint32_t killed = drain(coalition, 0);
                emit(@{@"kind": @"recovered", @"activeProcesses": @0, @"terminatedProcesses": @(killed)}); return 0;
            }
            if (argc == 3 && strcmp(argv[1], "host") == 0) {
                host([NSString stringWithUTF8String:argv[2]]); return 0;
            }
            fail(@"arguments", EINVAL);
        } @catch (NSException *error) {
            if (can_drain && host_coalition) {
                @try { (void)drain(host_coalition, getpid()); } @catch (__unused NSException *ignored) {}
            }
            @try {
                emit(@{@"kind": @"error", @"stage": error.name && [error.name isEqual:@"AifNativeFailure"] ? error.reason : @"native_exception",
                    @"nativeCode": error.userInfo[@"nativeCode"] ?: @(EPROTO)});
                if (control_fd >= 0) flush_final();
            } @catch (__unused NSException *ignored) {}
            return 1;
        }
    }
}
`;
