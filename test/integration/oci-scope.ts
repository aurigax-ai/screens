export const xvncOnlyTests: Record<string, string> = {
  'SCR-C7 ': 'lists host folders as the Xvnc sandbox shows them inside; CON-C8 covers containers',
  'SCR-C9 ': 'plants symlinks in the Xvnc link folder; CON-C9 and CON-C10 cover the stdio stream',
  'SCR-C10 ':
    'finds screens-init through the host /proc by the screen folder; CON-C9 and CON-C10 cover a broken stream',
  'SCR-C11 ': 'writes to the Xvnc link launch socket; CON-C10 covers unrequested channels',
  'SCR-C26 ': 'counts host processes that mention the screen folder; CON-C18 covers container stop',
  'SCR-C36 container sockets': 'the Xvnc sandbox hides host sockets; CON-C8 covers containers',
}

export const ociTestNamePattern = `^(?!(${Object.keys(xvncOnlyTests).join('|')}))`
