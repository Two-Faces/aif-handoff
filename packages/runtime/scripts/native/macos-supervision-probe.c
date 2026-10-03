/* Host-owned diagnostic fixture. Never used as a production stop certificate.
 * ABI reference: apple-oss-distributions/xnu bsd/sys/proc_info_private.h,
 * osfmk/mach/coalition.h and libsyscall/wrappers/libproc/libproc.c.
 * Only the fixed fixture can fork. Query/signal modes never execute task text.
 */
#define _DARWIN_C_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

/* Public SDKs need not ship the private declarations. Check the returned ABI
 * sizes at runtime; never accept a truncated or changed structure. */
struct probe_unique {
    uint8_t image[16];
    uint64_t unique, parent_unique;
    int32_t version, parent_version;
    uint64_t reserved[2];
};
struct probe_identity { struct proc_bsdinfo bsd; struct probe_unique unique; };
struct probe_coalitions { uint64_t resource, jetsam, reserved[3]; };
_Static_assert(sizeof(struct probe_unique) == 56, "Unexpected unique identity ABI");
_Static_assert(sizeof(struct probe_coalitions) == 40, "Unexpected coalition identity ABI");
typedef int (*signal_by_token_fn)(audit_token_t *, int);
typedef int (*usage_fn)(uint64_t, void *, size_t);
static signal_by_token_fn signal_by_token;
static usage_fn read_usage;

static int error_result(const char *stage, int number) {
    printf("{\"ok\":false,\"stage\":\"%s\",\"errno\":%d}\n", stage, number);
    return 1;
}
static int inspect(pid_t pid, struct probe_identity *identity, struct probe_coalitions *coalitions) {
    struct probe_identity second = {0};
    memset(identity, 0, sizeof(*identity)); memset(coalitions, 0, sizeof(*coalitions));
    errno = 0;
    if (proc_pidinfo(pid, 18, 0, identity, sizeof(*identity)) != (int)sizeof(*identity)) return errno ? errno : EPROTO;
    if (identity->bsd.pbi_pid != (uint32_t)pid || !identity->unique.unique) return EPROTO;
    if (proc_pidinfo(pid, 20, 0, coalitions, sizeof(*coalitions)) != (int)sizeof(*coalitions)) return errno ? errno : EPROTO;
    if (proc_pidinfo(pid, 18, 0, &second, sizeof(second)) != (int)sizeof(second)) return errno ? errno : EPROTO;
    // A changed incarnation is uncertainty, not proof that the old process exited.
    if (identity->unique.unique != second.unique.unique || identity->unique.version != second.unique.version) return EAGAIN;
    return 0;
}
static bool fixture_image(pid_t pid) {
    char own[PATH_MAX], target[PATH_MAX], own_real[PATH_MAX], target_real[PATH_MAX];
    uint32_t size = sizeof(own);
    if (_NSGetExecutablePath(own, &size) != 0 || proc_pidpath(pid, target, sizeof(target)) <= 0) return false;
    return realpath(own, own_real) && realpath(target, target_real) && strcmp(own_real, target_real) == 0;
}
static int emit_identity(FILE *out, pid_t pid) {
    struct probe_identity identity; struct probe_coalitions coalitions;
    int error = inspect(pid, &identity, &coalitions);
    if (error) return error;
    fprintf(out, "{\"ok\":true,\"pid\":%d,\"ppid\":%u,\"uid\":%u,\"pgid\":%u,\"uniqueId\":\"%" PRIu64 "\",\"pidVersion\":%u,\"birthSeconds\":\"%" PRIu64 "\",\"birthMicros\":%" PRIu64 ",\"coalitionId\":\"%" PRIu64 "\",\"fixtureImage\":%s}\n",
        pid, identity.bsd.pbi_ppid, identity.bsd.pbi_uid, identity.bsd.pbi_pgid,
        identity.unique.unique, (uint32_t)identity.unique.version,
        identity.bsd.pbi_start_tvsec, identity.bsd.pbi_start_tvusec, coalitions.resource, fixture_image(pid) ? "true" : "false");
    return 0;
}
static bool path_for(char *out, const char *root, const char *name) {
    return snprintf(out, PATH_MAX, "%s/%s", root, name) < PATH_MAX;
}
static int save_identity(const char *root, const char *name) {
    char path[PATH_MAX]; if (!path_for(path, root, name)) return ENAMETOOLONG;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return errno;
    FILE *file = fdopen(fd, "w"); if (!file) { int e = errno; close(fd); return e; }
    int error = emit_identity(file, getpid());
    if (fflush(file) != 0 && !error) error = errno;
    if (fsync(fd) != 0 && !error) error = errno;
    fclose(file); return error;
}
static bool flag(const char *root, const char *name) {
    char path[PATH_MAX]; return path_for(path, root, name) && access(path, F_OK) == 0;
}
static void bounded_wait(const char *root, bool write_marker) {
    char path[PATH_MAX];
    if (!path_for(path, root, "writes.txt")) _exit(20);
    // Fixture lifetime is bounded even if its JS driver crashes. This is test
    // cleanup only: elapsed time is NEVER interpreted as a stop certificate.
    alarm(45);
    while (!flag(root, "stop")) {
        if (write_marker) {
            int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0600);
            if (fd < 0) _exit(21);
            if (write(fd, "x", 1) != 1) { close(fd); _exit(22); }
            close(fd);
        }
        usleep(20000);
    }
}
static int fixture(const char *mode, const char *root) {
    struct stat st;
    if (lstat(root, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077) != 0) return error_result("fixture_directory", EACCES);
    alarm(45);
    int error = save_identity(root, strcmp(mode, "control") == 0 ? "control.json" : "root.json");
    if (error) return error_result("fixture_identity", error);
    if (strcmp(mode, "control") == 0) { bounded_wait(root, false); return 0; }
    while (!flag(root, "go")) { if (flag(root, "stop")) return 0; usleep(20000); }
    pid_t child = fork();
    if (child < 0) return error_result("fork", errno);
    if (child == 0) {
        alarm(45);
        if (setsid() < 0) _exit(23);
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(24);
        if (grandchild > 0) _exit(0);
        alarm(45);
        if (save_identity(root, "grandchild.json") != 0) _exit(25);
        bounded_wait(root, true); _exit(0);
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return error_result("fixture_fork_exit", ECHILD);
    bounded_wait(root, false); return 0;
}
static bool decimal(const char *text, uint64_t *number) {
    if (!*text) return false;
    for (const char *c = text; *c; ++c) if (*c < '0' || *c > '9') return false;
    errno = 0; char *end = NULL; *number = strtoull(text, &end, 10);
    return errno == 0 && end && !*end;
}
int main(int argc, char **argv) {
    alarm(8);
    signal_by_token = (signal_by_token_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
    read_usage = (usage_fn)dlsym(RTLD_DEFAULT, "coalition_info_resource_usage");
    if (argc == 2 && strcmp(argv[1], "symbols") == 0) {
        printf("{\"ok\":true,\"auditSignal\":%s,\"coalitionUsage\":%s}\n", signal_by_token ? "true" : "false", read_usage ? "true" : "false"); return 0;
    }
    if (argc == 3 && (strcmp(argv[1], "worker") == 0 || strcmp(argv[1], "control") == 0)) return fixture(argv[1], argv[2]);
    uint64_t number = 0;
    if (argc < 3 || !decimal(argv[2], &number)) return error_result("arguments", EINVAL);
    if (argc == 3 && strcmp(argv[1], "usage") == 0) {
        if (!read_usage) return error_result("usage_symbol", ENOTSUP);
        // The kernel supports prefix reads of this versioned accounting struct.
        uint64_t counts[2] = {0}; errno = 0;
        int rc = read_usage(number, counts, sizeof(counts));
        if (rc != 0) return error_result("usage", errno ? errno : EIO);
        if (counts[1] > counts[0]) return error_result("usage_shape", EPROTO);
        printf("{\"ok\":true,\"coalitionId\":\"%" PRIu64 "\",\"started\":\"%" PRIu64 "\",\"exited\":\"%" PRIu64 "\",\"active\":\"%" PRIu64 "\"}\n", number, counts[0], counts[1], counts[0]-counts[1]); return 0;
    }
    if (number == 0 || number > INT_MAX) return error_result("pid", EINVAL);
    pid_t pid = (pid_t)number;
    if (argc == 3 && strcmp(argv[1], "inspect") == 0) {
        int error = emit_identity(stdout, pid); return error ? error_result("inspect", error) : 0;
    }
    if ((argc == 6 && strcmp(argv[1], "stale") == 0) || (argc == 7 && strcmp(argv[1], "signal") == 0)) {
        uint64_t unique, version, coalition, signum = SIGCONT;
        if (!signal_by_token) return error_result("signal_symbol", ENOTSUP);
        if (!decimal(argv[3], &unique) || !decimal(argv[4], &version) || version > UINT32_MAX || !decimal(argv[5], &coalition)) return error_result("identity_arguments", EINVAL);
        if (argc == 7 && (!decimal(argv[6], &signum) || (signum != SIGKILL && signum != SIGCONT))) return error_result("signal_arguments", EINVAL);
        struct probe_identity identity; struct probe_coalitions coalitions;
        int error = inspect(pid, &identity, &coalitions);
        if (error) return error_result("signal_inspect", error);
        if (identity.bsd.pbi_uid != geteuid() || identity.unique.unique != unique || (uint32_t)identity.unique.version != version || coalitions.resource != coalition) return error_result("identity_mismatch", ESRCH);
        if (!fixture_image(pid)) return error_result("fixture_image_mismatch", EPERM);
        audit_token_t token = {{0}};
        token.val[1] = identity.bsd.pbi_uid; token.val[2] = identity.bsd.pbi_gid;
        token.val[3] = identity.bsd.pbi_ruid; token.val[4] = identity.bsd.pbi_rgid;
        token.val[5] = (uint32_t)pid; token.val[7] = (uint32_t)version;
        bool stale = strcmp(argv[1], "stale") == 0;
        if (stale) token.val[7] ^= UINT32_C(0x80000000);
        int rc = signal_by_token(&token, (int)signum);
        printf("{\"ok\":%s,\"stage\":\"audit_signal\",\"errno\":%d,\"stale\":%s}\n", rc == 0 ? "true" : "false", rc, stale ? "true" : "false"); return rc == 0 ? 0 : 1;
    }
    return error_result("arguments", EINVAL);
}
