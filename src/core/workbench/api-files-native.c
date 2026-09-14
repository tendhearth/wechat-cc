#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* openat's variadic mode argument has a distinct ABI on Apple arm64. */
int api_openat(int fd, const char *path, int flags, int mode) {
    return openat(fd, path, flags, mode);
}

int api_mkdirat(int fd, const char *path, int mode) {
    return mkdirat(fd, path, mode);
}

/* Bounded, descriptor-anchored enumeration. Never resolves an entry's path. */
int api_listdir(int fd, unsigned char *output, int capacity, int max_entries, int *truncated) {
    int copied = 0, count = 0;
    int owned = dup(fd);
    if (owned < 0) return -1;
    DIR *directory = fdopendir(owned);
    if (!directory) { close(owned); return -1; }
    *truncated = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) {
            if (errno) { closedir(directory); return -1; }
            break;
        }
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        int length = strlen(entry->d_name);
        if (count >= max_entries || length + 2 > capacity - copied) {
            *truncated = 1;
            break;
        }
        output[copied++] = entry->d_type == DT_REG ? 1 : entry->d_type == DT_DIR ? 2 : entry->d_type == DT_LNK ? 3 : 4;
        memcpy(output + copied, entry->d_name, length + 1);
        copied += length + 1;
        count++;
    }
    closedir(directory);
    return copied;
}
