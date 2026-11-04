# -*- coding: utf-8 -*-
"""提示词增强引擎自检（纯本地，不联网）。

用法：python3 backend/_prompt_test.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import prompt_enhance as pe  # noqa: E402

OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("  PASS  " if cond else "  FAIL  ") + name + (f"   [{extra}]" if extra else ""))


def section_titles(prompt):
    return re.findall(r"^## (.+)$", prompt, re.M)


def constraint_lines(prompt):
    block = prompt.split("## 约束条件", 1)[1].split("\n## ", 1)[0]
    return [ln for ln in block.splitlines() if re.match(r"^\d+\. ", ln)]


print("\n提示词增强引擎自检")
print("─" * 52)

# 1. 基础校验
try:
    pe.enhance("")
    check("空输入拒绝", False)
except pe.PromptError:
    check("空输入拒绝", True)

check("2000 字通过", bool(pe.enhance("a" * pe.MAX_INPUT)["prompt"]))
try:
    pe.enhance("a" * (pe.MAX_INPUT + 1))
    check("2001 字拒绝", False)
except pe.PromptError:
    check("2001 字拒绝", True)

# 2. 通用结构
r = pe.enhance("检查日志，排查解决运行时崩溃的问题")
check("自动识别为编程场景", r["scene"] == "coding", r["scene"])
titles = section_titles(r["prompt"])
check("六个章节齐全", titles == ["角色", "任务目标", "背景与输入", "约束条件", "输出格式", "自检"],
      str(titles))
check("原文逐字保留", "检查日志，排查解决运行时崩溃的问题" in r["prompt"])
check("排障分支定位根因", "根本原因" in r["prompt"])
check("排障分支说明位置与触发条件", "具体位置" in r["prompt"] and "触发条件" in r["prompt"])
check("排障分支给修复方案", "修复方案" in r["prompt"])
check("排障分支含验证方式", "验证方式" in r["prompt"] and "不再出现" in r["prompt"])
check("编程约束含测试", "测试" in r["prompt"])
check("输出格式含代码块", "代码块" in r["prompt"])

# 3. 详细度
for detail, n in (("concise", 3), ("standard", 5), ("detailed", 8)):
    rr = pe.enhance("写一段产品介绍", scene="writing", detail=detail)
    check(f"{detail} 约束 {n} 条", len(constraint_lines(rr["prompt"])) == n,
          str(len(constraint_lines(rr["prompt"]))))
check("简洁模式无自检", "## 自检" not in pe.enhance("写一段产品介绍", scene="writing",
                                                  detail="concise")["prompt"])

# 4. 场景差异
w = pe.enhance("给新品写一篇公众号推文", scene="writing")
check("写作场景识别", w["scene"] == "writing")
check("写作约束含标题候选", "标题" in w["prompt"])
d = pe.enhance("分析这份销售数据", scene="data")
check("数据场景用表格", "Markdown 表格" in d["prompt"])
a = pe.enhance("写一篇关于大模型的综述", scene="academic")
check("学术场景含引用", "引用权威来源" in a["prompt"] and "逻辑严密" in a["prompt"])
t = pe.enhance("把这段话翻译成英文", scene="translation")
check("翻译场景只输出译文", "只输出译文" in t["prompt"])

# 5. 缺项检测
m = pe.enhance("帮我写个脚本", scene="coding")
check("缺项最多 3 个", 0 < len(m["missing"]) <= 3, str(m["missing"]))
check("缺项占位符出现", "【待补充：" in m["prompt"])
m2 = pe.enhance("用 Python 3.12 在 Linux 上写个脚本，输入输出示例如下", scene="coding")
check("已提供信息不再提示", "编程语言与版本" not in m2["missing"], str(m2["missing"]))
m3 = pe.enhance("写一篇公众号文章，面向新手，800 字", scene="writing",
                audience="新手")
check("提供受众后不提示目标读者", "目标读者" not in m3["missing"], str(m3["missing"]))

# 6. 高级配置
adv = pe.enhance("优化这段代码", scene="coding", role="custom", custom_role="性能优化专家",
                 tone="concise", fmt="table", language="zh", detail="standard")
check("自定义角色生效", "性能优化专家" in adv["prompt"])
check("语气生效", "简洁明了" in adv["prompt"])
check("格式覆盖为表格", "Markdown 表格" in adv["prompt"])
check("语言指令为中文", "回答语言：简体中文" in adv["prompt"])

preset = pe.enhance("写个函数", scene="coding", role="programmer")
check("角色预设生效", "资深软件工程师" in preset["prompt"])

json_r = pe.enhance("提取字段", scene="general", fmt="json")
check("JSON 格式指令", "合法 JSON" in json_r["prompt"])

# 7. 语言
en = pe.enhance("write a python script to rename files", scene="coding", language="en")
check("英文场景标题", "## Role" in en["prompt"] and "## Objective" in en["prompt"])
check("英文语言指令", "Answer language: English" in en["prompt"])
both = pe.enhance("写一段介绍", language="both")
check("双语指令", "中英双语" in both["prompt"])
auto_en = pe.enhance("write a blog post about self-hosting", scene="writing")
check("英文输入自动英文提示词", auto_en["language"] == "en" and "## Role" in auto_en["prompt"])

# 8. 用户补充
extra = pe.enhance("写个脚本", scene="coding", constraints="不要使用第三方库\n必须兼容 Windows")
check("用户约束并入", "不要使用第三方库" in extra["prompt"] and "必须兼容 Windows" in extra["prompt"])
with_ex = pe.enhance("写一段文案", scene="writing", examples="示例：把复杂的事讲简单")
check("示例并入背景", "示例：把复杂的事讲简单" in with_ex["prompt"])

# 9. 截断
long_text = "需求：" + ("内容" * 990)
trunc = pe.enhance(long_text, scene="general", detail="detailed")
check("输出最长 8000 字左右", len(trunc["prompt"]) <= pe.MAX_OUTPUT + 40,
      str(len(trunc["prompt"])))

# 10. AI 后处理
check("去掉代码围栏", pe.clean_ai_prompt("```markdown\n## 角色\n你是一位顾问。这是足够长的提示词内容，用于测试。\n```",
                                          "fallback").startswith("## 角色"))
check("过短结果回退", pe.clean_ai_prompt("太短", "fallback") == "fallback")
check("道歉结果回退", pe.clean_ai_prompt("抱歉，我无法完成这个请求。", "fallback") == "fallback")
check("正常结果保留", pe.clean_ai_prompt("## 角色\n你是一位严谨的顾问。请给出完整、可执行的步骤和验证方式。",
                                        "fallback").startswith("## 角色"))

# 11. 非法枚举
try:
    pe.enhance("测试", scene="unknown")
    check("非法场景拒绝", False)
except pe.PromptError as e:
    check("非法场景拒绝", e.field == "scene")

print("─" * 52)
print(f"通过 {len(OK)} 项，失败 {len(FAIL)} 项")
if FAIL:
    print("失败：", "；".join(FAIL))
    sys.exit(1)
