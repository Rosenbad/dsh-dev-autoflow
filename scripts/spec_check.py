#!/usr/bin/env python3
"""
spec_check.py - 需求规格完整性校验器

用法:
    python spec_check.py <spec-file>          检查规格文件
    python spec_check.py -                     从 stdin 读入规格文本

检查项:
    1. 必填字段是否齐全 (目标/受众/交付形态/核心功能/范围边界/技术约束/验收标准)
    2. 每条核心功能是否都有对应验收标准
    3. 验收标准是否可测 (含可验证动词)
    4. 是否声明了"不做的事" (范围边界防过度开发)

退出码: 0=通过, 1=有缺失或不可测项
"""

import re
import sys
from pathlib import Path

REQUIRED_FIELDS = [
    "目标",
    "受众",
    "交付形态",
    "核心功能",
    "范围边界",
    "技术约束",
    "验收标准",
]

# 验收标准中出现这些词视为"可测"
TESTABLE_VERBS = [
    "能", "可", "打开", "运行", "显示", "展示", "返回", "输出",
    "刷新", "生成", "解析", "通过", "达到", "不超过", ">=<",
    "跑通", "渲染", "点击", "切换", "提交", "保存",
    "number", "count", "verify", "pass", "fail",
]

# 允许字段名变体: 如"受众/使用场景"归入"受众"
FIELD_ALIASES = {
    "受众": "受众",
    "受众/使用场景": "受众",
    "使用场景": "受众",
    "交付形态": "交付形态",
    "目标": "目标",
    "核心功能": "核心功能",
    "功能": "核心功能",
    "范围边界": "范围边界",
    "不做": "范围边界",
    "技术约束": "技术约束",
    "验收标准": "验收标准",
    "成本预算": "成本预算",
    "待确认项": "待确认项",
}

FIELD_PATTERN = re.compile(r"【([^】]+)】")


def extract_fields(text: str) -> dict:
    """把规格文本按【字段】切分为 dict，变体字段名归一化。"""
    fields = {}
    matches = list(FIELD_PATTERN.finditer(text))
    for i, m in enumerate(matches):
        raw_name = m.group(1).strip()
        name = FIELD_ALIASES.get(raw_name, raw_name)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        # 同一字段多次出现则追加
        if name in fields:
            fields[name] = fields[name] + "\n" + text[start:end].strip()
        else:
            fields[name] = text[start:end].strip()
    return fields


def check_spec(text: str) -> tuple[bool, list[str]]:
    problems = []
    fields = extract_fields(text)

    # 1. 必填字段
    missing = [f for f in REQUIRED_FIELDS if f not in fields or not fields[f]]
    for f in missing:
        problems.append(f"缺少必填字段: 【{f}】")

    # 字段都存在时才做后续检查
    if "核心功能" in fields and "验收标准" in fields:
        # 2. 统计核心功能条数 (按编号 1. 2. 3. 或 - 列表)
        features = [
            line.strip() for line in fields["核心功能"].splitlines()
            if re.match(r"^\s*(1\.|-|\d+[.)、])\s*\S", line)
        ]
        accepts = [
            line.strip() for line in fields["验收标准"].splitlines()
            if re.match(r"^\s*(1\.|-|\d+[.)、])\s*\S", line)
        ]
        if len(accepts) < len(features):
            problems.append(
                f"验收标准({len(accepts)}条)少于核心功能({len(features)}条): 每条功能都应有对应验收标准"
            )
        # 3. 可测性
        untestable = [
            line for line in accepts
            if not any(v in line for v in TESTABLE_VERBS)
        ]
        for line in untestable:
            problems.append(f"验收标准不可测(缺可验证动词): {line[:60]}")

    # 4. 范围边界是否声明"不做"
    if "范围边界" in fields and fields["范围边界"]:
        rb = fields["范围边界"]
        if "不" not in rb and "不做" not in rb:
            problems.append("【范围边界】未声明'不做'的内容, 请明确排除项")

    return len(problems) == 0, problems


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)

    if sys.argv[1] == "-":
        text = sys.stdin.read()
    else:
        path = Path(sys.argv[1])
        if not path.exists():
            print(f"错误: 文件不存在 {path}")
            sys.exit(2)
        text = path.read_text(encoding="utf-8")

    ok, problems = check_spec(text)

    if ok:
        print("PASS: 需求规格字段完整, 验收标准可测")
        sys.exit(0)
    else:
        print("FAIL: 规格存在以下问题:")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)


if __name__ == "__main__":
    main()
