/* The variadic mode argument uses a distinct ABI on Apple arm64. */
extern int openat(int fd, const char *path, int flags, ...);
int attachment_openat(int fd, const char *path, int flags, int mode) {
    return openat(fd, path, flags, mode);
}
