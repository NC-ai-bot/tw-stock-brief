# 核對網頁附檔與 repo 程式是否一致
#   python3 tools/check_sync.py 下載目錄
# 下載目錄：用 Artifact read 取回 pipeline/*.txt 存放的目錄（其中要有 pipeline/ 子目錄或直接放 *.txt）。
# 比對三件事：附檔 = repo 的 .py、repo 的 .py = SHA256SUMS、附檔齊全。全部一致回傳 0，否則回傳 1。
import sys, os, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.join(ROOT, 'pipeline')


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


def main(src):
    if os.path.isdir(os.path.join(src, 'pipeline')):
        src = os.path.join(src, 'pipeline')
    sums = dict(reversed(l.split()) for l in open(os.path.join(PIPE, 'SHA256SUMS')) if l.strip())
    ok = True
    for name, want in sums.items():
        repo = sha(os.path.join(PIPE, name))
        art_path = os.path.join(src, name[:-3] + '.txt')
        art = sha(art_path) if os.path.exists(art_path) else None
        if repo != want:
            st = 'repo 與 SHA256SUMS 不符'
        elif art is None:
            st = '網頁附檔缺少'
        elif art != repo:
            st = '網頁附檔與 repo 不同'
        else:
            st = '一致'
        ok &= st == '一致'
        print(f'{name:15} {st:20} {want[:12]}')
    print('全部一致' if ok else '有不一致，請先處理再發布')
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__ or '用法：python3 tools/check_sync.py 下載目錄')
    sys.exit(main(sys.argv[1]))
