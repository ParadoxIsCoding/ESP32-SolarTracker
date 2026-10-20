"""Run esptool against a Growatt ShineWiFi-X on macOS.

The stick's USB-serial bridge (Exar XR21V1410, 04e2:1410) enumerates as plain
CDC-ACM, so macOS binds AppleUSBACM. That driver leaves the bridge in hardware
RTS/CTS flow-control mode (and re-applies it on every open), and CTS isn't wired
on the stick, so nothing is ever transmitted to the ESP8266.

This wrapper patches pyserial so that, right after esptool opens the port, the
bridge's flow control is switched off via XR21V141x vendor register writes
(the same thing Linux's xr_serial driver does). It only touches volatile bridge
registers; all esptool arguments are passed through unchanged.

Usage: python3 tools/xr_esptool.py --port /dev/cu.usbmodemXXXX --before no-reset <command> ...
Requires: pyusb, libusb (brew install libusb), esptool.
"""
import sys

import serial
import usb.backend.libusb1
import usb.core

XR_VID, XR_PID = 0x04E2, 0x1410
REG_UART_ENABLE, REG_FLOW_CTRL, REG_GPIO_MODE = 0x03, 0x0C, 0x1A


def _xr_disable_flow_control():
    backend = usb.backend.libusb1.get_backend(
        find_library=lambda _: "/opt/homebrew/lib/libusb-1.0.dylib"
    )
    dev = usb.core.find(idVendor=XR_VID, idProduct=XR_PID, backend=backend)
    if dev is None:
        print("xr_esptool: XR21V1410 not found, leaving port as-is", file=sys.stderr)
        return

    def write(reg, val):
        dev.ctrl_transfer(0x40, 0x00, val, reg, None, timeout=1000)

    write(REG_UART_ENABLE, 0x00)
    write(REG_FLOW_CTRL, 0x00)
    write(REG_GPIO_MODE, 0x00)
    write(REG_UART_ENABLE, 0x03)


_orig_open = serial.Serial.open
_orig_baud_setter = serial.Serial.baudrate.fset


def _patched_open(self):
    _orig_open(self)
    _xr_disable_flow_control()


def _patched_baud(self, value):
    _orig_baud_setter(self, value)
    if self.is_open:
        _xr_disable_flow_control()


serial.Serial.open = _patched_open
serial.Serial.baudrate = property(serial.Serial.baudrate.fget, _patched_baud)

if __name__ == "__main__":
    import esptool

    esptool._main()
