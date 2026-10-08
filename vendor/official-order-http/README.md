# 官网 HTTP 传输依赖

固定 `curl_cffi==0.16.3` 与间接依赖；使用其实际支持的 `chrome150` TLS/UA 配置。仅保存哈希锁与官方摘要核验记录，wheel 二进制不入库。运行环境为 Linux x86_64 / CPython 3.12，Node 以 `python -I` 启动独立 venv。

来源：[curl_cffi PyPI](https://pypi.org/project/curl_cffi/0.16.3/)、[官方文档](https://curl-cffi.readthedocs.io/en/v0.16.3/_modules/curl_cffi/requests/session.html)。

在可信环境下载 `requirements.lock` 中制品和清单指定的官方 pip wheel，先核验 SHA256SUMS，再执行：

```bash
python3 -m venv --without-pip /runtime/venv
/runtime/venv/bin/python /runtime/wheels/pip-26.2.1-py3-none-any.whl/pip install --no-index --find-links /runtime/wheels --require-hashes -r /runtime/wheels/requirements.lock
```

不禁用证书校验，不自动升级依赖；更新 profile 或依赖需要新的真实样本验收。
