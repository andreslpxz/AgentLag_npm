import sys

content = open('cli.jsx').read()

# The mess I made:
bad_part = """    if (screen === 'language') {
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
        }"""

if bad_part in content:
    content = content.replace(bad_part, "")
    with open('cli.jsx', 'w') as f:
        f.write(content)
    print("Fixed successfully")
else:
    print("Not found")
