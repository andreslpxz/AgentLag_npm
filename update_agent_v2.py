import sys

content = open('agent.js').read()

new_imports = """import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatCohere } from "@langchain/cohere";
import { getModelInfo } from "./model_info.js";"""

if 'import { ChatAnthropic }' not in content:
    content = 'import { ChatOpenAI } from "@langchain/openai";\nimport { ChatAnthropic } from "@langchain/anthropic";\n' + new_imports + '\n' + content

# Find buildLLM
if "function buildLLM" in content:
    print("Found buildLLM")
    # I already added the logic with the previous script, let's check
    if "provider === 'google'" in content:
        print("Logic already exists")
    else:
        # Fallback manual insertion if needed
        pass

with open('agent.js', 'w') as f:
    f.write(content)
