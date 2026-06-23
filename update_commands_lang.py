import sys

content = open('commands.js').read()

lang_cmd = """        case '/language': {
            setScreen('language');
            setMenuIndex(0);
            return true;
        }"""

insertion_point = "    switch (cmd) {"
if "/language" not in content:
    content = content.replace(insertion_point, insertion_point + "\n" + lang_cmd)

with open('commands.js', 'w') as f:
    f.write(content)
