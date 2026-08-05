export function CameraSwitchDisplay () {
  this.set = (text) => {
    const el = document.getElementById('camera-switch-display')
    if (el) el.textContent = text
  }

  this.reset = () => this.set('')
}
