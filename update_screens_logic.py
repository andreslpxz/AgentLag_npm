import sys

content = open('cli.jsx').read()

old_logic = "        if (screen === 'color') {"
new_logic = """        if (screen === 'language') {
            const languages = getAvailableLanguages();
            if (key.upArrow)   setMenuIndex(i => Math.max(0, i - 1));
            if (key.downArrow) setMenuIndex(i => Math.min(languages.length - 1, i + 1));
            if (key.return) {
                const selectedLang = languages[menuIndex];
                setLanguage(selectedLang);
                cfg.current = { ...cfg.current, language: selectedLang };
                saveConfig(cfg.current);
                setMenuIndex(0);
                setScreen('color');
            }
            return;
        }
        if (screen === 'color') {"""

if old_logic in content and "screen === 'language'" not in content:
    content = content.replace(old_logic, new_logic)
    with open('cli.jsx', 'w') as f:
        f.write(content)
    print("Updated successfully")
else:
    print("Already updated or not found")
