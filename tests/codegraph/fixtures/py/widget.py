import os
from payments_api.client import Client
from .helpers import load

LIMIT = 3


class Widget:
    def render(self):
        return load(self)


def top(x):
    return os.getcwd()
