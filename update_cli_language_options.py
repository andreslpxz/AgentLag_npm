import sys

content = open('cli.jsx').read()

# Add /language command to SLASH_COMMANDS
insertion = "    { cmd: '/mcp',"
if "/language" not in content:
    content = content.replace(insertion, "    { cmd: '/language', desc: ['Cambiar el idioma de la interfaz'] },\n" + insertion)

# Add case /language in handleSlashCommand (inside commands.js actually)
with open('cli.jsx', 'w') as f:
    f.write(content)
