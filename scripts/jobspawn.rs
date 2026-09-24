//! cc-jobspawn —— 让「杀掉整棵进程树」在 Windows 上也成立的一层壳。
//!
//! # 它为什么存在
//!
//! POSIX 上产品靠 `detached: true` + `process.kill(-pid, sig)` 杀**进程组**。那一步
//! 不是优化:`claude -p` / `codex` / `agy` 都会自己再开子进程(MCP 服务端、Task 子
//! 代理),只杀直接子进程留下的孙子会继续跑、继续烧额度、继续写文件。
//!
//! Windows **没有进程组**这个东西,Node / Bun 也都没有替代能力。于是产品里十几处
//! `process.kill(-pid)` 在 win32 上一律退化成 `child.kill()`,孙子留在系统里,而且
//! 没有任何日志说这件事发生了(2026-09-23 在 win-test 真机复现过:父进程杀掉后
//! 孙子仍在跑,`ParentProcessId` 核对确认过辈分)。
//!
//! 正确机制是 Windows 的 Job Object。`taskkill /T /F` **不够**:它按父 PID 走树,
//! 中间进程先退出树就断了,而且 PID 可被复用 —— 拿它当「可靠」是制造假象。
//!
//! # 做法:把**自己**放进 job,而不是把子进程放进 job
//!
//! 本程序开一个设了 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 job,把**当前进程**
//! 加进去,然后照常 spawn 真正的命令。之后 spawn 出来的一切自动继承 job 成员身份。
//!
//! 这个选择买到两件事:
//!
//! 1. **没有竞态,不需要 `CREATE_SUSPENDED` + `ResumeThread`。** 「先 spawn 子进程、
//!    再 `AssignProcessToJobObject` 它」那条路有一个真实窗口:子进程在被 assign
//!    之前就可能已经 fork 出孙子,那些孙子永远不在 job 里。而「先把自己放进 job、
//!    再 spawn」这个顺序里,`CreateProcess` 返回时新进程**已经**是成员 —— 内核在
//!    创建时就继承,不存在「还没加进去」的那一瞬间。
//! 2. **调用方的杀法一行都不用改。** 上层原有的 `child.kill()` 杀掉的是本程序;
//!    本程序一死,它持有的 job 句柄随之关闭,`KILL_ON_JOB_CLOSE` 这一刻生效,
//!    内核把整棵树终止。所以十几处 `process.kill(-pid)` 保持原样。
//!
//! 代价:本程序自己也是 job 成员,和整棵树同生共死 —— 这正是我们要的。
//!
//! # POSIX 上是直通
//!
//! 非 Windows 上本程序不做任何 job 相关的事,直接 `exec` 目标命令**替换掉自己**:
//! 同一个 pid、同一套 stdio、退出码与信号语义完全是目标命令自己的,进程树里不多
//! 一层。之所以要在 POSIX 上也构建:`tauri.conf.json` 的 `externalBin` 一旦加了
//! 条目,当前 target 的文件必须存在,否则 mac / linux 的 `tauri build` 直接失败。
//! 宁可在 POSIX 上多带一个两百来 KB 的直通程序,也不要按平台改配置那种脆弱做法。
//! (TS 侧只在 win32 包,所以 POSIX 上正常根本不会走到这个程序。)
//!
//! # 两条硬规矩
//!
//! * **stdout 只属于被包的命令。** ACP 与 codex app-server 都靠 stdin/stdout 的
//!   JSON-RPC,往 stdout 写一个字节就是往协议流里插脏东西(spike 原型正是在这里
//!   踩了坑:它把 `jobspawn pid=...` 打在 stdout 上)。本程序的诊断**一律 stderr**,
//!   而且 pid 那行只在 `WECHAT_CC_JOBSPAWN_DEBUG` 置位时才打 —— stderr 会被上层
//!   收进错误文案里,平时也得干净。
//! * **job 设置失败不许让命令跑不起来。** 今天的状态是「静默漏进程树」;失败时
//!   大声写 stderr 然后**照常执行命令**,只是退回到今天的行为(漏,但有人知道)。
//!   直接退出会让整个功能不可用,比漏更糟。
//!
//! # 构建
//!
//! 零外部 crate(win-test 是域机,未必连得上 crates.io):只用 std + 手写的
//! kernel32 声明。`apps/desktop/scripts/build-sidecar.ts` 用
//! `rustc -O --edition 2021` 单文件编译成
//! `apps/desktop/src-tauri/binaries/cc-jobspawn-<rustTriple>[.exe]`。
//!
//! # 它不解决什么(别当银弹)
//!
//! * 已经漏在系统里的旧进程 —— 只管新起的树。
//! * daemon 自己被杀 —— 本程序会成为孤儿,树跟着它继续活。POSIX 今天也一样
//!   (杀 daemon 不会杀进程组),所以不是回归,是同一条既有缺口。
//! * 子进程显式 `CREATE_BREAKAWAY_FROM_JOB` 会**失败**(我们没设 `BREAKAWAY_OK`,
//!   这是我们要的);`CREATE_SILENT_FAIL_BREAKAWAY` 会静默留在 job 里,同样安全。
//! * 嵌套 job 需要 Windows 8+;我们只支持 Win10+。

use std::process::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("cc-jobspawn: 用法 cc-jobspawn <命令> [参数...]");
        std::process::exit(2);
    }
    #[cfg(windows)]
    windows_job::enter_kill_on_close_job();
    exec_target(&args);
}

/// 调试开关:置位才打 pid 行,而且只打到 stderr。
#[cfg(windows)]
const DEBUG_ENV: &str = "WECHAT_CC_JOBSPAWN_DEBUG";

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;

    type Handle = *mut c_void;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_INFORMATION: u32 = 9;

    extern "system" {
        fn CreateJobObjectW(attrs: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: u32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn GetLastError() -> u32;
    }

    /// 失败一律「大声 + 继续」:退回今天的行为(只杀直接子进程),但有人知道。
    fn degraded(step: &str, code: u32) {
        eprintln!(
            "cc-jobspawn: {step} 失败(GetLastError={code}) —— 进程树清理已退化,\
             这条命令的孙子进程在被杀之后可能残留;命令照常执行。"
        );
    }

    pub fn enter_kill_on_close_job() {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                degraded("CreateJobObjectW", GetLastError());
                return;
            }
            let mut info = ExtendedLimit::default();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            ) == 0
            {
                degraded("SetInformationJobObject", GetLastError());
                return;
            }
            // 把**自己**放进 job:之后 spawn 的一切都自动是成员,没有竞态。
            if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
                degraded("AssignProcessToJobObject(self)", GetLastError());
                return;
            }
            // 故意不 CloseHandle(job):句柄活在本进程里,本进程一死它才关,
            // 那一刻 KILL_ON_JOB_CLOSE 才会把整棵树收掉。
        }
        if std::env::var_os(super::DEBUG_ENV).is_some() {
            eprintln!("cc-jobspawn: pid={} job=kill-on-close", std::process::id());
        }
    }
}

/// POSIX:`exec` 替换掉自己 —— 同 pid、同 stdio、退出码与信号都是目标命令自己的。
#[cfg(unix)]
fn exec_target(args: &[String]) -> ! {
    use std::os::unix::process::CommandExt;
    let error = Command::new(&args[0]).args(&args[1..]).exec();
    eprintln!("cc-jobspawn: exec `{}` 失败: {error}", args[0]);
    std::process::exit(6);
}

/// Windows(以及别的非 unix):等目标命令退出,把退出码原样透出去。
#[cfg(not(unix))]
fn exec_target(args: &[String]) -> ! {
    match Command::new(&args[0]).args(&args[1..]).status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("cc-jobspawn: spawn `{}` 失败: {error}", args[0]);
            std::process::exit(6);
        }
    }
}
