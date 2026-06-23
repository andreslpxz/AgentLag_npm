import sys

content = open('cli.jsx').read()

old_init = """    const initScreen = () => {
        if (!initCfg.colorSet) return 'color';
        if (!initCfg.trusted)  return 'trust';
        if (!initCfg.provider) return 'provider';
        if (!initCfg.model)    return 'model';
        return 'main';
    };"""

new_init = """    const initScreen = () => {
        if (!initCfg.language) return 'language';
        if (!initCfg.colorSet) return 'color';
        if (!initCfg.trusted)  return 'trust';
        if (!initCfg.provider) return 'provider';
        if (!initCfg.model)    return 'model';
        return 'main';
    };"""

if old_init in content:
    content = content.replace(old_init, new_init)
    with open('cli.jsx', 'w') as f:
        f.write(content)
    print("Updated successfully")
else:
    print("Not found")
